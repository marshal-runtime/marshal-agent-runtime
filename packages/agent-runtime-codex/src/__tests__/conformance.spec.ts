import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  assertAdapterConformance,
  createComposerConformanceFixture,
  type AdapterCallContext,
  type AdapterConformanceCaseName,
  type AdapterConformanceFixture,
  type AdapterExecutionRequest,
  type AdapterSearchRequest,
  type JsonRecord,
} from '@marshal/agent-runtime-conformance';
import { describe, expect, it } from 'vitest';
import type {
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeSearchRequest,
} from '../ports.js';
import { createCodexMcpServer } from '../server.js';

describe('Codex MCP adapter conformance', () => {
  it('passes the portable adapter contract through the real MCP dispatcher', async () => {
    const report = await assertAdapterConformance(createCodexConformanceFixture());
    expect(report).toMatchObject({ ok: true, passed: 12, failed: 0, skipped: 0 });
  });
});

function createCodexConformanceFixture(): AdapterConformanceFixture {
  const composerFixture = createComposerConformanceFixture();
  const manifest = {
    ...composerFixture.manifest,
    legacyAliases: { operation: true, implicitTarget: true },
  };
  return {
    name: 'codex-mcp',
    manifest,
    async create(caseName: AdapterConformanceCaseName) {
      const base = await composerFixture.create(caseName);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'codex-conformance', version: '1.0.0' });
      const resourceToolAttempts: Record<string, number> = {};
      const runtimeToolFallbacks: Record<string, number> = {};
      const server = createCodexMcpServer({
        kernel: {
          async search(request: RuntimeSearchRequest, context: RuntimeCallContext) {
            return await base.port.search(
              request as AdapterSearchRequest,
              baseContext(context, manifest.primaryContext),
            );
          },
          async execute(request: RuntimeExecutionRequest, context: RuntimeCallContext) {
            return await base.port.execute(
              request as AdapterExecutionRequest,
              baseContext(context, manifest.primaryContext),
            );
          },
        },
        lifecycle: {
          async startSession(request) {
            return await base.port.lifecycle.start(
              {
                protocolVersion: required(request.protocolVersion, 'protocolVersion'),
                eventId: required(request.eventId, 'eventId'),
                sessionId: request.sessionId,
                metadata: request.metadata,
              },
              baseContext({ sessionId: request.sessionId }, manifest.primaryContext),
            );
          },
          async observeTurn(request) {
            return await base.port.lifecycle.observe(
              {
                protocolVersion: required(request.protocolVersion, 'protocolVersion'),
                eventId: required(request.eventId, 'eventId'),
                sessionId: request.sessionId,
                kind: request.kind,
                content: request.content,
                metadata: request.metadata,
              },
              baseContext({ sessionId: request.sessionId }, manifest.primaryContext),
            );
          },
          async endSession(request) {
            return await base.port.lifecycle.end(
              {
                protocolVersion: required(request.protocolVersion, 'protocolVersion'),
                eventId: required(request.eventId, 'eventId'),
                sessionId: request.sessionId,
                outcome: request.outcome,
                metadata: request.metadata,
              },
              baseContext({ sessionId: request.sessionId }, manifest.primaryContext),
            );
          },
        },
        resources: {
          listResources: async () => [],
          readResource: async (uri) => ({ uri, text: '' }),
          callTool: async (name, input, context) => {
            increment(resourceToolAttempts, name);
            const result = await base.port.callTool(
              name,
              input,
              baseContext(context, manifest.primaryContext),
            );
            return transportResult(result);
          },
        },
      });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      return {
        port: {
          async search(request, context) {
            return callStructured(client, 'runtime_search', {
              ...request,
              context: codexContext(context),
            }, undefined, codexRequestMeta(context));
          },
          async execute(request, context) {
            const signal = context.signal instanceof AbortSignal ? context.signal : undefined;
            try {
              return await callStructured(
                client,
                'runtime_exec',
                { ...request, context: codexContext(context) },
                signal,
                codexRequestMeta(context),
              );
            } catch (error) {
              if (!signal?.aborted) throw error;
              return { status: 'cancelled', receipt: { status: 'cancelled' } };
            }
          },
          lifecycle: {
            start: (request) => callStructured(client, 'runtime_session_start', { ...request }),
            observe: (request) => callStructured(client, 'runtime_observe_turn', { ...request }),
            end: (request) => callStructured(client, 'runtime_session_end', { ...request }),
          },
          async callTool(name, input, context) {
            if (name === manifest.resourceFallback.toolName) {
              increment(runtimeToolFallbacks, name);
            }
            return callStructured(
              client,
              name,
              { ...input, context: codexContext(context) },
              undefined,
              codexRequestMeta(context),
            );
          },
          createCancellation() {
            const controller = new AbortController();
            return {
              signal: controller.signal,
              abort: (reason?: unknown) => controller.abort(reason),
            };
          },
        },
        async inspect() {
          const observations = await base.inspect();
          return {
            ...observations,
            resourceToolAttempts: { ...resourceToolAttempts },
            runtimeToolFallbacks: { ...runtimeToolFallbacks },
          };
        },
        async dispose() {
          await client.close();
          await server.close();
          await base.dispose?.();
        },
      };
    },
  };
}

async function callStructured(
  client: Client,
  name: string,
  args: JsonRecord,
  signal?: AbortSignal,
  meta?: JsonRecord,
): Promise<unknown> {
  const result = await client.callTool(
    { name, arguments: { ...args }, ...(meta ? { _meta: meta } : {}) },
    undefined,
    signal ? { signal } : undefined,
  );
  return result.structuredContent;
}

function baseContext(
  context: RuntimeCallContext,
  template: AdapterCallContext,
): AdapterCallContext {
  return {
    principalId: context.agentId ?? template.principalId,
    requestId: context.requestId,
    scope: {
      ...template.scope,
      sessionId: context.sessionId ?? template.scope.sessionId,
    },
    signal: context.signal,
    metadata: context.metadata,
  };
}

function codexContext(context: AdapterCallContext): JsonRecord {
  return {
    sessionId: context.scope.sessionId,
    agentId: context.principalId,
    workspacePath: 'C:/codex-conformance-workspace',
    metadata: context.metadata,
  };
}

function codexRequestMeta(context: AdapterCallContext): JsonRecord {
  const sessionId = context.scope.sessionId;
  const threadId = context.scope.threadId ?? sessionId;
  return {
    threadId,
    'x-codex-turn-metadata': {
      session_id: sessionId,
      thread_id: threadId,
      turn_id: context.requestId,
    },
  };
}

function transportResult(value: unknown) {
  const structuredContent = isRecord(value) ? value : { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
