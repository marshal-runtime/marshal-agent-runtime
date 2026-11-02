import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubagentBackend, SubagentSnapshot } from '@marshal/agent-runtime-codex-capabilities';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexRuntime } from '../runtime.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex adaptive application actions', () => {
  it('routes declared actions through runtime permissions, receipts, and durable idempotency', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'marshal-codex-ui-action-'));
    cleanup.push(workspace);
    await writeFile(
      join(workspace, 'App.tsx'),
      `export default function App({ marshal }) {
        return <button onClick={() => marshal.callAction('acknowledge', { incidentId: 'inc-1' }, { scope: 'project', idempotencyKey: 'once' })}>Acknowledge</button>;
      }`,
      'utf8',
    );
    await writeFile(
      join(workspace, 'backend.ts'),
      `export default function transform(input) { return { transformed: input.value.toUpperCase() }; }`,
      'utf8',
    );
    const invoke = vi.fn(async (_name: string, input: unknown) => ({
      output: { acknowledged: true, incidentId: (input as { incidentId: string }).incidentId },
    }));
    const provider = {
      id: 'test.incidents',
      version: '1.0.0',
      list: () => [{
        protocolVersion: '1.0.0',
        name: 'incidents.acknowledge',
        version: '1.0.0',
        description: 'Acknowledge an incident.',
        inputSchema: {
          type: 'object',
          properties: { incidentId: { type: 'string' } },
          required: ['incidentId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { acknowledged: { type: 'boolean' }, incidentId: { type: 'string' } },
          required: ['acknowledged', 'incidentId'],
          additionalProperties: false,
        },
        permissions: [{ permission: 'incidents.write', risk: 'medium' as const }],
      }],
      invoke,
    };
    const runtime = await createCodexRuntime({
      principal: { id: 'codex', kind: 'agent' },
      workspacePath: workspace,
      permissionProfile: 'trusted-local',
      permissionPatterns: ['incidents.write'],
      providerSources: [() => provider],
      capabilities: { subagentBackend: noopBackend() },
    });
    try {
      const compiled = responseOutput(await runtime.kernel.execute({
        targetType: 'operation',
        target: 'ui.compile',
        input: { entryPath: 'App.tsx', title: 'Incident acknowledgement' },
      }, { sessionId: 'ui-task' }));
      const componentId = String(record(compiled.component).id);
      const application = {
        version: '1.0.0',
        presentationModes: ['inline', 'fullscreen', 'pip'],
        actions: [
          {
            id: 'acknowledge',
            version: '1.0.0',
            target: { kind: 'capability', capability: 'incidents.acknowledge' },
            inputSchema: {
              type: 'object', properties: { incidentId: { type: 'string' } },
              required: ['incidentId'], additionalProperties: false,
            },
            outputSchema: {
              type: 'object', properties: { acknowledged: { type: 'boolean' }, incidentId: { type: 'string' } },
              required: ['acknowledged', 'incidentId'], additionalProperties: false,
            },
            allowedScopes: ['project'],
            requiredPermissions: ['incidents.write'],
            risk: 'write',
            idempotency: 'required',
          },
          {
            id: 'transform',
            version: '1.0.0',
            target: { kind: 'module', module: { kind: 'workspace_file', path: 'backend.ts' } },
            inputSchema: {
              type: 'object', properties: { value: { type: 'string' } },
              required: ['value'], additionalProperties: false,
            },
            outputSchema: {
              type: 'object', properties: { transformed: { type: 'string' } },
              required: ['transformed'], additionalProperties: false,
            },
            allowedScopes: ['project'],
            requiredPermissions: ['runtime.module.execute'],
            risk: 'read',
            idempotency: 'supported',
          },
          {
            id: 'forbidden',
            version: '1.0.0',
            target: { kind: 'capability', capability: 'incidents.acknowledge' },
            inputSchema: {
              type: 'object', properties: { incidentId: { type: 'string' } },
              required: ['incidentId'], additionalProperties: false,
            },
            outputSchema: { type: 'object' },
            allowedScopes: ['project'],
            requiredPermissions: ['incidents.admin'],
            risk: 'write',
            idempotency: 'none',
          },
        ],
        tools: [],
        localState: { scope: 'project', schemaVersion: '1.0.0' },
      };
      const rendered = responseOutput(await runtime.kernel.execute({
        targetType: 'operation',
        target: 'ui.render',
        input: {
          componentId,
          props: {},
          fallback: { summary: 'Incident acknowledgement controls.' },
          application,
        },
      }, { sessionId: 'ui-task' }));
      const renderId = String(record(rendered.render).id);
      const call = () => runtime.resources!.callTool!(
        'marshal_invoke_react_action',
        {
          renderId,
          actionId: 'acknowledge',
          input: { incidentId: 'inc-1' },
          scope: 'project',
          idempotencyKey: 'once',
        },
        { sessionId: 'ui-task' },
      );
      const first = await call();
      const replayed = await call();
      expect(first?.structuredContent).toMatchObject({
        status: 'success',
        output: { acknowledged: true, incidentId: 'inc-1' },
        receipt: {
          actionId: 'acknowledge',
          permission: { decision: 'allow', grants: ['incidents.write'] },
          targetReceipt: { target: 'incidents.acknowledge', status: 'success' },
        },
      });
      const firstReceipt = record(record(first?.structuredContent).receipt);
      const targetReceipt = record(firstReceipt.targetReceipt);
      expect(targetReceipt.executionId).not.toBe(firstReceipt.receiptId);
      expect(targetReceipt.lineage).toEqual({
        rootExecutionId: firstReceipt.receiptId,
        parentExecutionId: firstReceipt.receiptId,
        depth: 1,
      });
      expect(replayed?.structuredContent).toMatchObject({ receipt: { replayed: true } });
      expect(invoke).toHaveBeenCalledTimes(1);
      const transformed = await runtime.resources!.callTool!(
        'marshal_invoke_react_action',
        {
          renderId,
          actionId: 'transform',
          input: { value: 'marshal' },
          scope: 'project',
          idempotencyKey: 'transform-once',
        },
        { sessionId: 'ui-task' },
      );
      expect(transformed?.structuredContent).toMatchObject({
        status: 'success',
        output: { transformed: 'MARSHAL' },
        receipt: { targetReceipt: { target: 'runtime.module.execute', status: 'success' } },
      });
      const forbidden = await runtime.resources!.callTool!(
        'marshal_invoke_react_action',
        {
          renderId,
          actionId: 'forbidden',
          input: { incidentId: 'inc-2' },
          scope: 'project',
        },
        { sessionId: 'ui-task' },
      );
      expect(forbidden?.structuredContent).toMatchObject({
        status: 'denied',
        receipt: { permission: { decision: 'deny' } },
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      const persisted = await runtime.receipts.list({ principalId: 'codex' });
      expect(persisted.filter((receipt) => receipt.target === 'incidents.acknowledge')).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

function responseOutput(value: unknown): Record<string, unknown> {
  const response = record(value);
  if (response.status !== 'success') throw new Error(JSON.stringify(response));
  return record(record(response.result).output);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function noopBackend(): SubagentBackend {
  const missing = async (): Promise<SubagentSnapshot> => ({
    id: 'unused', status: 'unknown', workspacePath: process.cwd(),
  });
  return {
    spawn: missing,
    run: async () => ({ thread: await missing(), response: '', status: 'failed' }),
    list: async () => [],
    steer: missing,
    followUp: async () => ({ thread: await missing(), response: '', status: 'failed' }),
    wait: missing,
    cancel: missing,
    inspect: missing,
  };
}
