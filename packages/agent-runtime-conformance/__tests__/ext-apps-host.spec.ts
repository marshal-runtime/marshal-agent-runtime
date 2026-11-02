import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { AppBridge, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { describe, expect, it } from 'vitest';
import {
  MarshalUiClient,
  UI_ACTION_TOOL_NAME,
  type UiLifecycleEvent,
  type UiProtocolMessage,
  type UiProtocolTransport,
} from '@marshal/agent-runtime-ui';
import { createAdaptiveApplicationConformanceFixture } from '../src/index.js';

describe('official MCP Apps host bridge integration', () => {
  it('runs the portable adaptive application through the published ext-apps AppBridge', async () => {
    const environment = await createAdaptiveApplicationConformanceFixture({
      name: 'official-ext-apps-app-bridge',
    }).create('display-mode-negotiation');
    const render = await environment.provision();
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const initialized = deferred<void>();
    const hostRequests: Array<{ method: string; params: unknown }> = [];
    const bridge = new AppBridge(
      null,
      { name: 'Marshal ext-apps conformance host', version: '1.0.0' },
      { serverTools: {}, serverResources: {} },
      {
        hostContext: {
          theme: 'light',
          locale: 'en-US',
          timeZone: 'UTC',
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen'],
        },
      },
    );
    bridge.oninitialized = () => initialized.resolve();
    bridge.onrequestdisplaymode = async (params) => {
      hostRequests.push({ method: 'ui/request-display-mode', params });
      return { mode: params.mode === 'fullscreen' ? 'inline' : params.mode };
    };
    bridge.oncalltool = async (params) => {
      hostRequests.push({ method: 'tools/call', params });
      if (params.name !== UI_ACTION_TOOL_NAME) {
        return {
          content: [{ type: 'text', text: `Unknown test tool ${params.name}.` }],
          isError: true,
        };
      }
      return await environment.invokeAction(
        render.renderId,
        asRecord(params.arguments),
      ) as CallToolResult;
    };

    const officialTransport = sdkTransportAsUiProtocol(viewTransport);
    let client: MarshalUiClient | undefined;
    try {
      await bridge.connect(hostTransport);
      client = await MarshalUiClient.connect({
        appInfo: { name: 'Marshal adaptive application', version: '1.0.0' },
        application: environment.manifest,
        renderId: render.renderId,
        transport: officialTransport,
      });
      await initialized.promise;

      const rendererMetadata = asRecord(environment.rendererToolMetadata());
      expect(getToolUiResourceUri({ _meta: rendererMetadata })).toBe(render.rendererUri);
      expect(render.rendererUri).toMatch(/^ui:\/\//);
      expect(client.host.context).toMatchObject({
        theme: 'light',
        timeZone: 'UTC',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
      });

      await expect(client.requestDisplayMode('fullscreen')).resolves.toMatchObject({
        requested: 'fullscreen',
        actual: 'inline',
        status: 'fallback',
      });
      await expect(client.requestDisplayMode('pip')).resolves.toMatchObject({
        requested: 'pip',
        actual: 'inline',
        status: 'unsupported',
      });

      const action = await client.callAction<{ incidentId: string }, { acknowledged: boolean }>(
        'acknowledge',
        { incidentId: 'INC-42' },
        { scope: 'project', idempotencyKey: 'official-ext-apps-action-once' },
      );
      expect(action).toMatchObject({
        status: 'success',
        output: { acknowledged: true },
        receipt: {
          actionId: 'acknowledge',
          scope: 'project',
          permission: { decision: 'allow', grants: ['incidents.write'] },
        },
      });

      const lifecycle: UiLifecycleEvent[] = [];
      client.subscribe((event) => lifecycle.push(event));
      await bridge.sendToolInput({ arguments: { incidentId: 'INC-42' } });
      await bridge.sendToolResult({
        content: [{ type: 'text', text: 'Incident loaded.' }],
        structuredContent: { incidentId: 'INC-42', status: 'open' },
      });
      await bridge.sendToolCancelled({ reason: 'cancelled by official host bridge' });
      bridge.setHostContext({ theme: 'dark' });
      await eventually(() => lifecycle.some((event) => event.type === 'host-context-changed'));

      expect(lifecycle.map((event) => event.type)).toEqual([
        'tool-input',
        'tool-result',
        'tool-cancelled',
        'host-context-changed',
      ]);
      expect(client.host.context).toMatchObject({
        theme: 'dark',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
      });
      expect(hostRequests).toEqual([
        { method: 'ui/request-display-mode', params: { mode: 'fullscreen' } },
        {
          method: 'tools/call',
          params: {
            name: UI_ACTION_TOOL_NAME,
            arguments: {
              renderId: render.renderId,
              actionId: 'acknowledge',
              input: { incidentId: 'INC-42' },
              scope: 'project',
              idempotencyKey: 'official-ext-apps-action-once',
            },
          },
        },
      ]);
      expect(environment.inspect().actionExecutions).toBe(1);
    } finally {
      client?.close();
      await bridge.close();
      await environment.dispose();
    }
  }, 60_000);
});

function sdkTransportAsUiProtocol(transport: Transport): UiProtocolTransport {
  let sequence = 0;
  const listeners = new Set<(message: UiProtocolMessage) => void>();
  const pending = new Map<RequestId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  let started: Promise<void>;

  transport.onmessage = (message) => {
    const id = 'id' in message ? message.id : undefined;
    if (id !== undefined && ('result' in message || 'error' in message)) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if ('error' in message) {
        request.reject(Object.assign(new Error(message.error.message), {
          code: message.error.code,
          data: message.error.data,
        }));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if ('method' in message) {
      const event: UiProtocolMessage = {
        jsonrpc: '2.0',
        ...(id !== undefined ? { id } : {}),
        method: message.method,
        ...('params' in message ? { params: message.params } : {}),
      };
      for (const listener of [...listeners]) listener(event);
    }
  };
  transport.onerror = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  transport.onclose = () => {
    const error = new Error('Official MCP Apps host transport closed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  started = transport.start();

  return {
    async request<TResult>(method: string, params: unknown): Promise<TResult> {
      await started;
      const id = ++sequence;
      return await new Promise<TResult>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject,
        });
        void transport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage)
          .catch((error: unknown) => {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
    notify(method: string, params: unknown): void {
      void started
        .then(() => transport.send({ jsonrpc: '2.0', method, params } as JSONRPCMessage))
        .catch((error: unknown) => transport.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        ));
    },
    subscribe(listener: (message: UiProtocolMessage) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for official host notification.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
