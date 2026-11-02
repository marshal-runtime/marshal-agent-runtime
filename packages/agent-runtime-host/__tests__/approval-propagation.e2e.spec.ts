import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type PermissionBroker,
  type PermissionCheck,
} from '@marshal/agent-runtime-core';
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  type AgentRuntimeBindings,
  type AgentRuntimeHostOptions,
  type RuntimeHostFactoryContext,
} from '../src/index.js';

const cleanup: string[] = [];
const runtimes: AgentRuntimeBindings[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const target of cleanup.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

describe('nested approval propagation', () => {
  it('surfaces brokered TypeScript approval and succeeds with exact verified evidence', async () => {
    const approval = approvalPolicy();
    const runtime = await fixture({
      permissionPatterns: ['runtime.inline_module.execute'],
      permissionApproval: approval,
    });
    const request = {
      targetType: 'inline_module' as const,
      source: `
        export default async (input, context) =>
          context.runtime.invoke('test.approved', input);
      `,
      input: { value: 21 },
    };

    const unapproved = await runtime.kernel.execute(
      { ...request, requestId: 'inline-approval-parent' },
      { sessionId: 'inline-approval' },
    );

    expect(unapproved).toMatchObject({
      status: 'approval_required',
      approval: {
        decision: 'approval',
        approvalId: 'approval:test.approved',
      },
      receipt: {
        executionId: 'inline-approval-parent',
        status: 'approval_required',
      },
    });
    expect(unapproved.result).toBeUndefined();
    await expectValidSingleChildTree(
      runtime,
      'inline-approval-parent',
      'test.approved',
      'approval_required',
    );

    const approved = await runtime.kernel.execute(
      {
        ...request,
        requestId: 'inline-approved-parent',
        approval: approvalEvidence(runtime, 'test.approved', 'test.approved'),
      },
      { sessionId: 'inline-approval' },
    );

    expect(approved).toMatchObject({
      status: 'success',
      result: {
        output: {
          ok: true,
          value: { value: 21 },
        },
      },
    });
    expect(
      approval.verifyApproval.mock.calls.some(
        ([evidence, check]) =>
          evidence.capability === 'test.approved'
          && check.capability.name === 'test.approved',
      ),
    ).toBe(true);
  });

  it('surfaces artifact-source approval with valid parent-child lineage', async () => {
    const approval = approvalPolicy();
    const runtime = await fixture({
      permissionPatterns: ['runtime.module.execute', 'artifacts.write'],
      permissionApproval: approval,
    });
    const written = await runtime.kernel.execute(
      {
        targetType: 'operation',
        target: 'artifacts.write',
        requestId: 'artifact-write',
        input: {
          path: 'modules/approved.ts',
          scope: 'project',
          content: 'export default (input: { value: number }) => input.value * 2;\n',
        },
      },
      { sessionId: 'artifact-approval' },
    );
    expect(written.status).toBe('success');

    const request = {
      targetType: 'module' as const,
      module: {
        kind: 'artifact' as const,
        path: 'modules/approved.ts',
        scope: 'project' as const,
      },
      input: { value: 21 },
    };
    const unapproved = await runtime.kernel.execute(
      { ...request, requestId: 'artifact-approval-parent' },
      { sessionId: 'artifact-approval' },
    );

    expect(unapproved).toMatchObject({
      status: 'approval_required',
      approval: {
        decision: 'approval',
        approvalId: 'approval:artifacts.read',
      },
      receipt: {
        executionId: 'artifact-approval-parent',
        status: 'approval_required',
      },
    });
    await expectValidSingleChildTree(
      runtime,
      'artifact-approval-parent',
      'artifacts.read',
      'approval_required',
    );

    const wrongApproval = await runtime.kernel.execute(
      {
        ...request,
        requestId: 'artifact-wrong-approval-parent',
        approval: approvalEvidence(runtime, 'test.approved', 'test.approved'),
      },
      { sessionId: 'artifact-approval' },
    );
    expect(wrongApproval.status).toBe('approval_required');

    const approved = await runtime.kernel.execute(
      {
        ...request,
        requestId: 'artifact-approved-parent',
        approval: approvalEvidence(runtime, 'artifacts.read', 'artifacts.read'),
      },
      { sessionId: 'artifact-approval' },
    );
    expect(approved).toMatchObject({
      status: 'success',
      result: {
        output: {
          ok: true,
          value: 42,
        },
      },
    });
  });

  it('surfaces approval through the generic host operation invoker', async () => {
    const approval = approvalPolicy();
    const runtime = await fixture({
      permissionPatterns: ['test.proxy'],
      permissionApproval: approval,
    });
    const request = {
      targetType: 'operation' as const,
      target: 'test.proxy',
      input: { target: 'test.approved', value: 7 },
    };

    const unapproved = await runtime.kernel.execute(
      { ...request, requestId: 'generic-approval-parent' },
      { sessionId: 'generic-approval' },
    );

    expect(unapproved).toMatchObject({
      status: 'approval_required',
      approval: {
        decision: 'approval',
        approvalId: 'approval:test.approved',
      },
    });
    await expectValidSingleChildTree(
      runtime,
      'generic-approval-parent',
      'test.approved',
      'approval_required',
    );

    const approved = await runtime.kernel.execute(
      {
        ...request,
        requestId: 'generic-approved-parent',
        approval: approvalEvidence(runtime, 'test.approved', 'test.approved'),
      },
      { sessionId: 'generic-approval' },
    );
    expect(approved).toMatchObject({
      status: 'success',
      result: {
        output: { value: 7 },
      },
    });
  });

  it('leaves nested denials and provider errors on their existing paths', async () => {
    const permissionBroker: PermissionBroker = {
      decide(check) {
        return check.capability.name === 'test.denied'
          ? {
              decision: 'deny',
              reason: 'Nested operation denied.',
              code: 'NESTED_DENIED',
            }
          : { decision: 'allow' };
      },
    };
    const runtime = await fixture({ permissionBroker });
    const inlineRequest = (target: string, requestId: string) =>
      runtime.kernel.execute(
        {
          targetType: 'inline_module',
          requestId,
          source: `
            export default async (input, context) =>
              context.runtime.invoke(input.target, { value: input.value });
          `,
          input: { target, value: 5 },
        },
        { sessionId: 'nested-non-approval' },
      );

    const denied = await inlineRequest('test.denied', 'inline-denied-parent');
    expect(denied).toMatchObject({
      status: 'success',
      result: {
        output: {
          ok: false,
          error: { code: 'NESTED_DENIED' },
        },
      },
    });

    const failed = await inlineRequest('test.error', 'inline-error-parent');
    expect(failed).toMatchObject({
      status: 'success',
      result: {
        output: {
          ok: false,
          error: { code: 'NESTED_FAILURE' },
        },
      },
    });

    const genericDenied = await runtime.kernel.execute(
      {
        targetType: 'operation',
        target: 'test.proxy',
        requestId: 'generic-denied-parent',
        input: { target: 'test.denied', value: 5 },
      },
      { sessionId: 'nested-non-approval' },
    );
    expect(genericDenied).toMatchObject({
      status: 'failed',
      error: { code: 'NESTED_DENIED' },
    });

    const genericFailed = await runtime.kernel.execute(
      {
        targetType: 'operation',
        target: 'test.proxy',
        requestId: 'generic-error-parent',
        input: { target: 'test.error', value: 5 },
      },
      { sessionId: 'nested-non-approval' },
    );
    expect(genericFailed).toMatchObject({
      status: 'failed',
      error: { code: 'NESTED_FAILURE' },
    });
  });
});

function approvalPolicy() {
  const requestApproval = vi.fn(
    async (check: PermissionCheck, missingPermissions: readonly string[]) => ({
      approvalId: `approval:${check.capability.name}`,
      reason: `Approval required for ${missingPermissions.join(', ')}.`,
      prompt: `Allow ${check.capability.name}?`,
    }),
  );
  const verifyApproval = vi.fn(
    async (approval: Readonly<Record<string, unknown>>, check: PermissionCheck) => {
      const permission = typeof approval.permission === 'string' ? approval.permission : undefined;
      const approved =
        approval.token === 'verified'
        && approval.capability === check.capability.name
        && approval.workspaceId === check.context.scope?.workspaceId
        && permission !== undefined
        && check.requirements.some((requirement) => requirement.permission === permission);
      return {
        approved,
        permissions: approved && permission ? [permission] : [],
      };
    },
  );
  return { requestApproval, verifyApproval };
}

function approvalEvidence(
  runtime: AgentRuntimeBindings,
  capability: string,
  permission: string,
): Readonly<Record<string, unknown>> {
  return {
    token: 'verified',
    capability,
    permission,
    workspaceId: runtime.workspaceId,
  };
}

async function fixture(
  options: Pick<
    AgentRuntimeHostOptions,
    'permissionApproval' | 'permissionBroker' | 'permissionPatterns'
  >,
): Promise<AgentRuntimeBindings> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-host-approval-'));
  cleanup.push(parent);
  const workspacePath = path.join(parent, 'workspace');
  await fs.mkdir(workspacePath);
  const runtime = await createAgentRuntime({
    workspacePath,
    protectedLifecycleResultRoot: path.join(parent, 'private'),
    providerSources: [
      createRuntimeBuiltinsSource({
        effects: false,
        scheduling: false,
      }),
      (context) => [nestedProvider(), proxyProvider(context)],
    ],
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

function nestedProvider(): CapabilityProvider {
  const descriptor = (name: string, permission: string) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description: `Nested approval fixture for ${name}.`,
    permissions: [{ permission, risk: 'medium' as const }],
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
  });
  const descriptors = [
    descriptor('test.approved', 'test.approved'),
    descriptor('test.denied', 'test.denied'),
    descriptor('test.error', 'test.error'),
  ];
  return {
    id: 'test.nested-approval',
    list: () => descriptors,
    get: (name) => descriptors.find((candidate) => candidate.name === name),
    async invoke(name, input) {
      if (name === 'test.error') {
        throw Object.assign(new Error('Nested provider failed.'), { code: 'NESTED_FAILURE' });
      }
      return { output: input };
    },
  };
}

function proxyProvider(context: RuntimeHostFactoryContext): CapabilityProvider {
  return {
    id: 'test.operation-proxy',
    list: () => [{
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: 'test.proxy',
      version: '1.0.0',
      description: 'Invokes another operation through the generic host broker.',
      permissions: [{ permission: 'test.proxy', risk: 'medium' }],
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    }],
    async invoke(_name, input, invocationContext) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
      const target = typeof record.target === 'string' ? record.target : 'test.approved';
      const value = typeof record.value === 'number' ? record.value : 0;
      return {
        output: await context.operationInvoker.invoke(target, { value }, invocationContext),
      };
    },
  };
}

async function expectValidSingleChildTree(
  runtime: AgentRuntimeBindings,
  rootExecutionId: string,
  childTarget: string,
  childStatus: 'approval_required',
): Promise<void> {
  const tree = await runtime.receipts.tree(rootExecutionId);
  expect(tree.orphans).toEqual([]);
  expect(tree.roots).toHaveLength(1);
  expect(tree.roots[0]?.receipt).toMatchObject({
    executionId: rootExecutionId,
    lineage: {
      rootExecutionId,
      depth: 0,
    },
  });
  expect(tree.roots[0]?.children).toHaveLength(1);
  expect(tree.roots[0]?.children[0]?.receipt).toMatchObject({
    target: childTarget,
    status: childStatus,
    lineage: {
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      depth: 1,
    },
  });
  expect(tree.roots[0]?.children[0]?.receipt.executionId).not.toBe(rootExecutionId);
}
