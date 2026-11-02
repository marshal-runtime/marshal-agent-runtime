import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRuntimeReceiptForest,
  type InvocationContext,
  type RuntimeExecResponse,
} from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionIdempotencyKey, actionRequestDigest, UiActionDispatcher } from '../actionDispatcher.js';
import type {
  UiActionIdempotencyStore,
  UiActionIdempotencyClaim,
  UiActionIdempotencyLease,
  UiActionIdempotencyRecord,
  UiActionDispatcherOptions,
  UiActionExecutionPort,
  UiActionExecutionRequest,
  UiActionJournalStore,
  UiApplicationManifest,
  UiProtocolMessage,
  UiProtocolTransport,
  UiStateScope,
} from '../applicationTypes.js';
import {
  UI_CHROME_ACTION_BINDING_METHOD,
  UI_CHROME_ACTION_CANCEL_METHOD,
  UI_CHROME_ACTION_REQUEST_METHOD,
  UI_CHROME_ACTION_RESULT_METHOD,
  UI_CHROME_ACTION_TIMEOUT_MS,
  UI_DECLARED_TOOL_NAME,
} from '../applicationTypes.js';
import { MarshalUiClient } from '../client.js';
import { createReactUiCapabilities } from '../factory.js';
import {
  REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS,
  REACT_UI_TEMPLATE_URI,
  reactUiTemplateContent,
} from '../runtimeRenderer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('portable adaptive application client', () => {
  it('routes declared tools through the render-bound server dispatcher', async () => {
    const transport = new TestTransport({ hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] } });
    const renderId = '9'.repeat(64);
    transport.respond('tools/call', (params) => {
      expect(params).toEqual({
        name: UI_DECLARED_TOOL_NAME,
        arguments: { renderId, toolId: 'incident', input: { incidentId: 'INC-1' } },
      });
      return { structuredContent: { status: 'success', output: { status: 'open' } } };
    });
    const client = await MarshalUiClient.connect({
      appInfo: { name: 'declared-tool', version: '1' },
      application: toolApplication(),
      renderId,
      transport,
    });
    await expect(client.callTool('incident', { incidentId: 'INC-1' })).resolves.toEqual({ status: 'open' });
    expect(transport.requests).not.toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ name: 'incidents.get' }),
    }));
  });

  it('negotiates modes, reports unsupported and fallback modes, and tracks host context', async () => {
    const transport = new TestTransport({
      protocolVersion: '2026-01-26',
      hostCapabilities: {
        serverTools: true,
        extensions: { openai: { methods: ['requestModal', 'selectFiles'] } },
      },
      hostContext: {
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        theme: 'light',
        locale: 'en-US',
      },
    });
    transport.respond('ui/request-display-mode', () => ({ mode: 'inline' }));
    transport.respond('marshal/extensions/call', () => ({
      namespace: 'openai', method: 'requestModal', status: 'success', result: { opened: true },
    }));
    const client = await MarshalUiClient.connect({
      appInfo: { name: 'test-app', version: '1.0.0' },
      application: application(),
      renderId: 'a'.repeat(64),
      transport,
    });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    await expect(client.requestDisplayMode('pip')).resolves.toMatchObject({
      status: 'unsupported', actual: 'inline',
    });
    expect(transport.requests.filter((item) => item.method === 'ui/request-display-mode')).toHaveLength(0);
    await expect(client.requestDisplayMode('fullscreen')).resolves.toMatchObject({
      status: 'fallback', actual: 'inline',
    });
    expect(transport.requests).toContainEqual({
      method: 'ui/request-display-mode', params: { mode: 'fullscreen' },
    });
    transport.emit({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: {
        displayMode: 'fullscreen',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        theme: 'dark',
        locale: 'he-IL',
        timezone: 'Asia/Jerusalem',
        containerDimensions: { width: 1200, height: 800 },
        safeAreaInsets: { top: 8, right: 12, bottom: 16, left: 12 },
      },
    });
    expect(client.host.context).toMatchObject({ theme: 'dark', locale: 'he-IL', displayMode: 'fullscreen' });
    expect(events).toContain('host-context-changed');
    expect(client.supportsHostExtension('openai', 'requestModal')).toBe(true);
    await expect(client.callHostExtension('openai', 'requestModal', [{ template: 'ui://example/modal' }])).resolves.toMatchObject({ status: 'success', result: { opened: true } });
    await expect(client.callHostExtension('openai', 'requestCheckout')).resolves.toMatchObject({ status: 'unsupported' });
    client.reportSize({ width: 700.2, height: 411.1 });
    expect(transport.notifications).toContainEqual({
      method: 'ui/notifications/size-changed', params: { width: 701, height: 412 },
    });
  });

  it('accepts the pre-standard displayMode response alias without preferring it over mode', async () => {
    const transport = new TestTransport({
      hostContext: {
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      },
    });
    transport.respond('ui/request-display-mode', () => ({
      mode: 'fullscreen',
      displayMode: 'pip',
    }));
    const client = await MarshalUiClient.connect({
      appInfo: { name: 'canonical-mode', version: '1' },
      application: application(),
      renderId: 'd'.repeat(64),
      transport,
    });
    await expect(client.requestDisplayMode('fullscreen')).resolves.toMatchObject({
      requested: 'fullscreen', actual: 'fullscreen', status: 'granted',
    });

    const compatibility = new TestTransport({
      hostContext: {
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
      },
    });
    compatibility.respond('ui/request-display-mode', () => ({ displayMode: 'fullscreen' }));
    const legacyClient = await MarshalUiClient.connect({
      appInfo: { name: 'compatibility-mode', version: '1' },
      application: application(),
      renderId: 'e'.repeat(64),
      transport: compatibility,
    });
    await expect(legacyClient.requestDisplayMode('fullscreen')).resolves.toMatchObject({
      requested: 'fullscreen', actual: 'fullscreen', status: 'granted',
    });
  });

  it('reports a host display-mode timeout as a typed timed_out outcome', async () => {
    const transport = new TestTransport({
      hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
    });
    transport.respond('ui/request-display-mode', () => {
      throw new Error('UI host request timed out: ui/request-display-mode');
    });
    const client = await MarshalUiClient.connect({
      appInfo: { name: 'timed-mode', version: '1' },
      application: application(),
      renderId: '8'.repeat(64),
      transport,
    });
    await expect(client.requestDisplayMode('fullscreen')).resolves.toEqual({
      requested: 'fullscreen',
      actual: 'inline',
      status: 'timed_out',
      reason: 'UI host request timed out: ui/request-display-mode',
    });
  });

  it('binds manifest chrome to one stateful action invocation and reports typed outcomes', async () => {
    const transport = new TestTransport({
      hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] },
    });
    const client = await MarshalUiClient.connect({
      appInfo: { name: 'chrome-actions', version: '1' },
      application: application(),
      renderId: 'f'.repeat(64),
      transport,
    });
    let complete!: () => void;
    const blocked = new Promise<void>((resolve) => { complete = resolve; });
    const handler = vi.fn(async () => blocked);
    const unbind = client.bindActionControl('acknowledge', handler);
    expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_BINDING_METHOD,
      params: { actionId: 'acknowledge', bound: true },
    });

    const request = {
      jsonrpc: '2.0' as const,
      method: UI_CHROME_ACTION_REQUEST_METHOD,
      params: { requestId: 'chrome-1', actionId: 'acknowledge' },
    };
    transport.emit(request);
    transport.emit(request);
    transport.emit({
      ...request,
      params: { requestId: 'chrome-2', actionId: 'acknowledge' },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_RESULT_METHOD,
      params: expect.objectContaining({
        requestId: 'chrome-2', actionId: 'acknowledge', status: 'unavailable',
        message: expect.stringContaining('already running'),
      }),
    });
    complete();
    await vi.waitFor(() => expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_RESULT_METHOD,
      params: expect.objectContaining({ requestId: 'chrome-1', actionId: 'acknowledge', status: 'success' }),
    }));

    unbind();
    transport.emit({
      ...request,
      params: { requestId: 'chrome-3', actionId: 'acknowledge' },
    });
    await vi.waitFor(() => expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_RESULT_METHOD,
      params: expect.objectContaining({ requestId: 'chrome-3', actionId: 'acknowledge', status: 'unavailable' }),
    }));
    expect(handler).toHaveBeenCalledTimes(1);

    client.bindActionControl('acknowledge', async () => ({
      status: 'denied', error: { message: 'Policy denied the action.' },
    }));
    transport.emit({
      ...request,
      params: { requestId: 'chrome-4', actionId: 'acknowledge' },
    });
    await vi.waitFor(() => expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_RESULT_METHOD,
      params: {
        requestId: 'chrome-4', actionId: 'acknowledge', status: 'denied',
        message: 'Policy denied the action.',
      },
    }));

    client.bindActionControl('acknowledge', async () => ({
      status: 'approval_required', error: { message: 'Approval is required.' },
    }));
    transport.emit({
      ...request,
      params: { requestId: 'chrome-5', actionId: 'acknowledge' },
    });
    await vi.waitFor(() => expect(transport.notifications).toContainEqual({
      method: UI_CHROME_ACTION_RESULT_METHOD,
      params: {
        requestId: 'chrome-5', actionId: 'acknowledge', status: 'approval_required',
        message: 'Approval is required.',
      },
    }));
  });

  it('cancels or times out chrome actions with an AbortSignal and typed outcomes', async () => {
    vi.useFakeTimers();
    try {
      const transport = new TestTransport({
        hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] },
      });
      const client = await MarshalUiClient.connect({
        appInfo: { name: 'bounded-chrome-actions', version: '1' },
        application: application(),
        renderId: '1'.repeat(64),
        transport,
      });
      const signals: AbortSignal[] = [];
      client.bindActionControl('acknowledge', ({ signal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      });

      transport.emit({
        jsonrpc: '2.0', method: UI_CHROME_ACTION_REQUEST_METHOD,
        params: { requestId: 'cancel-me', actionId: 'acknowledge' },
      });
      await vi.advanceTimersByTimeAsync(0);
      transport.emit({
        jsonrpc: '2.0', method: UI_CHROME_ACTION_CANCEL_METHOD,
        params: { requestId: 'cancel-me', actionId: 'different-action' },
      });
      transport.emit({
        jsonrpc: '2.0', method: UI_CHROME_ACTION_CANCEL_METHOD,
        params: { requestId: 'cancel-me' },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(signals[0]?.aborted).toBe(false);
      transport.emit({
        jsonrpc: '2.0', method: UI_CHROME_ACTION_CANCEL_METHOD,
        params: { requestId: 'cancel-me', actionId: 'acknowledge' },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(signals[0]?.aborted).toBe(true);
      expect(transport.notifications).toContainEqual({
        method: UI_CHROME_ACTION_RESULT_METHOD,
        params: expect.objectContaining({ requestId: 'cancel-me', status: 'cancelled' }),
      });

      transport.emit({
        jsonrpc: '2.0', method: UI_CHROME_ACTION_REQUEST_METHOD,
        params: { requestId: 'time-me-out', actionId: 'acknowledge' },
      });
      await vi.advanceTimersByTimeAsync(UI_CHROME_ACTION_TIMEOUT_MS);
      expect(signals[1]?.aborted).toBe(true);
      expect(transport.notifications).toContainEqual({
        method: UI_CHROME_ACTION_RESULT_METHOD,
        params: expect.objectContaining({ requestId: 'time-me-out', status: 'timed_out' }),
      });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers the complete tool lifecycle and tears down deterministically', async () => {
    const transport = new TestTransport({ hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] } });
    const client = await MarshalUiClient.connect({ appInfo: { name: 'events', version: '1' }, application: application(), renderId: 'b'.repeat(64), transport });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    for (const [method, params] of [
      ['ui/notifications/tool-input', { value: 1 }],
      ['ui/notifications/tool-input-partial', { value: 2 }],
      ['ui/notifications/tool-result', { value: 3 }],
      ['ui/notifications/tool-cancelled', { reason: 'stopped' }],
      ['ui/notifications/tool-error', { code: 'failed', message: 'failed' }],
      ['ui/notifications/teardown', { reason: 'closed' }],
    ] as const) transport.emit({ jsonrpc: '2.0', method, params });
    expect(events).toEqual(['tool-input', 'tool-input-partial', 'tool-result', 'tool-cancelled', 'tool-error', 'teardown']);
    expect(() => client.reportSize({ height: 1 })).toThrow('torn down');
  });
});

describe('declared application actions', () => {
  it('cancels claim waits and releases acquired leases without caching an orphan', async () => {
    const busyStore: UiActionIdempotencyStore = {
      get: async () => undefined,
      put: async () => undefined,
      claim: async () => ({ status: 'busy', retryAfterMs: 10_000 }),
      renew: async () => undefined,
      complete: async (_key, _scope, _lease, record) => record,
      release: async () => undefined,
    };
    const waiting = new UiActionDispatcher({
      loadApplication: async () => application(),
      authorize: { authorize: () => ({ decision: 'allow' }) },
      executor: { execute: async () => executionResponse({ acknowledged: true }) },
      idempotencyStore: busyStore,
      idempotencyPollMs: 10_000,
    });
    const waitingController = new AbortController();
    const waitingCall = waiting.invoke({
      renderId: '7'.repeat(64), actionId: 'acknowledge', input: { incidentId: 'wait' },
      scope: 'project', idempotencyKey: 'wait',
    }, { ...context('project-a'), signal: waitingController.signal });
    setTimeout(() => waitingController.abort(), 20);
    await expect(waitingCall).rejects.toMatchObject({ code: 'UI_ACTION_CANCELLED' });

    let releasedInterruptedClaim = false;
    const interruptedController = new AbortController();
    const interruptedStore: UiActionIdempotencyStore = {
      ...busyStore,
      async claim(_key, _scope, requestDigest) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          status: 'acquired',
          lease: {
            ownerId: '00000000-0000-4000-8000-000000000001',
            requestDigest,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      async release() { releasedInterruptedClaim = true; },
    };
    const interrupted = new UiActionDispatcher({
      loadApplication: async () => application(),
      authorize: { authorize: () => ({ decision: 'allow' }) },
      executor: { execute: async () => executionResponse({ acknowledged: true }) },
      idempotencyStore: interruptedStore,
    });
    const interruptedCall = interrupted.invoke({
      renderId: '6'.repeat(64), actionId: 'acknowledge', input: { incidentId: 'claim' },
      scope: 'project', idempotencyKey: 'claim',
    }, { ...context('project-a'), signal: interruptedController.signal });
    setTimeout(() => interruptedController.abort(), 10);
    await expect(interruptedCall).rejects.toMatchObject({ code: 'UI_ACTION_CANCELLED' });
    expect(releasedInterruptedClaim).toBe(true);

    for (const targetKind of ['capability', 'module'] as const) {
      const store = new MemoryIdempotencyStore();
      const controller = new AbortController();
      const manifest = targetKind === 'capability'
        ? application()
        : {
            ...application(),
            actions: [{
              ...application().actions[0]!, id: 'transform',
              target: { kind: 'module' as const, module: { kind: 'workspace_file' as const, path: 'backend.ts' } },
            }],
          };
      const dispatcher = new UiActionDispatcher({
        loadApplication: async () => manifest,
        authorize: { authorize: () => ({ decision: 'allow' }) },
        executor: {
          async execute() {
            while (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
            return executionResponse({ acknowledged: true });
          },
        },
        idempotencyStore: store,
        idempotencyPollMs: 5,
      });
      const call = dispatcher.invoke({
        renderId: '8'.repeat(64), actionId: targetKind === 'capability' ? 'acknowledge' : 'transform',
        input: { incidentId: 'cancel' }, scope: 'project', idempotencyKey: `cancel-${targetKind}`,
      }, { ...context('project-a'), signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(call).resolves.toMatchObject({ status: 'cancelled' });
      expect(store.leaseSize).toBe(0);
      expect(store.size).toBe(0);
    }
  });

  it('authorizes declared tools against the immutable render and rejects raw, undeclared, and cross-render calls', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Tools</p>}' });
    const execute = vi.fn(async (_tool, input): Promise<RuntimeExecResponse> => executionResponse({
      status: 'open', incidentId: (input as { incidentId: string }).incidentId,
    }));
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      toolRuntime: { execute },
    });
    const compiled = await bundle.provider.invoke('ui.compile', { entryPath: 'App.tsx', title: 'Tools' }, context('project-a'));
    const componentId = String((compiled.output.component as Record<string, unknown>).id);
    const rendered = await bundle.provider.invoke('ui.render', {
      componentId, props: {}, fallback: { summary: 'Declared tools.' }, application: toolApplication(),
    }, context('project-a'));
    const renderId = String((rendered.output.render as Record<string, unknown>).id);
    const other = await bundle.provider.invoke('ui.render', {
      componentId, props: { other: true }, fallback: { summary: 'No declared tools.' }, application: application(),
    }, context('project-a'));
    const otherRenderId = String((other.output.render as Record<string, unknown>).id);

    await expect(bundle.resources.invokeRenderTool(UI_DECLARED_TOOL_NAME, {
      renderId, toolId: 'incident', input: { incidentId: 'INC-1' },
    }, context('project-a'))).resolves.toMatchObject({
      structuredContent: { status: 'success', output: { status: 'open', incidentId: 'INC-1' } },
    });
    await expect(bundle.resources.invokeRenderTool(UI_DECLARED_TOOL_NAME, {
      renderId, toolId: 'undeclared', input: {},
    }, context('project-a'))).rejects.toThrow('is not declared');
    await expect(bundle.resources.invokeRenderTool(UI_DECLARED_TOOL_NAME, {
      renderId: otherRenderId, toolId: 'incident', input: { incidentId: 'INC-2' },
    }, context('project-a'))).rejects.toThrow('is not declared');
    await expect(bundle.resources.invokeRenderTool('incidents.get', { incidentId: 'INC-raw' }, context('project-a'))).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('validates schemas, permissions, idempotency, scopes, output, and receipts', async () => {
    const idempotencyStore = new MemoryIdempotencyStore();
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> => executionResponse({ acknowledged: true }));
    const dispatcher = new UiActionDispatcher({
      loadApplication: async () => application(),
      authorize: { authorize: () => ({ decision: 'allow', grants: ['incidents.write'] }) },
      executor: { execute },
      idempotencyStore,
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      receiptId: () => 'receipt-1',
    });
    const request = {
      renderId: 'c'.repeat(64),
      actionId: 'acknowledge',
      input: { incidentId: 'inc-1' },
      scope: 'project' as const,
      idempotencyKey: 'once',
      activation: {
        requestId: 'outer-save-1',
        surface: 'outer-renderer-chrome' as const,
        method: UI_CHROME_ACTION_REQUEST_METHOD,
        activatedAt: '2026-07-31T23:59:59.900Z',
        dispatchedAt: '2026-07-31T23:59:59.950Z',
      },
    };
    const [first, repeated] = await Promise.all([
      dispatcher.invoke(request, context('project-a')),
      dispatcher.invoke(request, context('project-a')),
    ]);
    expect(first).toMatchObject({ status: 'success', output: { acknowledged: true }, receipt: {
      actionId: 'acknowledge', scope: 'project', permission: { decision: 'allow' },
      activation: {
        requestId: 'outer-save-1', surface: 'outer-renderer-chrome',
        method: UI_CHROME_ACTION_REQUEST_METHOD,
        acceptedAt: '2026-08-01T00:00:00.000Z', dispatchOverheadMs: 100,
      },
    } });
    expect(repeated).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(dispatcher.invoke({ ...request, input: { incidentId: 'inc-2' } }, context('project-a'))).rejects.toThrow('reused with a different request');
    await expect(dispatcher.invoke({ ...request, input: { incidentId: 7 }, idempotencyKey: 'bad' }, context('project-a'))).rejects.toThrow('schema validation');
    await expect(dispatcher.invoke({ ...request, scope: 'workspace', idempotencyKey: 'scope' }, context('project-a'))).rejects.toThrow('does not allow');
  });

  it('replays an idempotent action after restart and isolates its project scope', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Actions</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> => executionResponse({ acknowledged: true }));
    const actionRuntime = {
      authorize: { authorize: () => ({ decision: 'allow' as const, grants: ['incidents.write'] }) },
      executor: { execute },
    };
    const first = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const renderId = await compileAndRender(first, context('project-a'));
    const request = {
      renderId,
      actionId: 'acknowledge',
      input: { incidentId: 'inc-1' },
      scope: 'project' as const,
      idempotencyKey: 'restart-safe',
      activation: {
        requestId: 'restart-outer-1',
        surface: 'outer-renderer-chrome' as const,
        method: UI_CHROME_ACTION_REQUEST_METHOD,
        activatedAt: '2026-08-01T00:00:00.000Z',
        dispatchedAt: '2026-08-01T00:00:00.010Z',
      },
    };
    await first.actionDispatcher!.invoke(request, context('project-a'));

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const replayed = await restarted.actionDispatcher!.invoke(request, context('project-a'));
    expect(replayed.receipt.replayed).toBe(true);
    expect(replayed.receipt.activation).toMatchObject({
      requestId: 'restart-outer-1',
      surface: 'outer-renderer-chrome',
      method: UI_CHROME_ACTION_REQUEST_METHOD,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(restarted.actionDispatcher!.invoke(request, context('project-b'))).rejects.toThrow('was not found');
  });

  it('replays a legacy successful action result when no root journal exists', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Legacy replay</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> =>
      executionResponse({ acknowledged: true }));
    const actionRuntime = {
      authorize: { authorize: () => ({ decision: 'allow' as const, grants: ['incidents.write'] }) },
      executor: { execute },
    };
    const first = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const renderId = await compileAndRender(first, context('project-a'));
    const request = actionRequest(renderId, 'legacy-result');
    await first.actionDispatcher!.invoke(request, context('project-a'));
    const journals = await findFilesEndingWith(stateRoot, '.jsonl');
    expect(journals).toHaveLength(1);
    const { rm } = await import('node:fs/promises');
    await Promise.all(journals.map((path) => rm(path)));

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    await expect(restarted.actionDispatcher!.invoke(
      request,
      context('project-a'),
    )).resolves.toMatchObject({
      status: 'success',
      receipt: { replayed: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('persists pending roots before authorization and restores one non-orphan receipt tree for every outcome', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Receipts</p>}' });
    const stateRoot = join(workspacePath, '.state');
    let sequence = 0;
    let pendingObservedBeforeAuthorization = false;
    const actionRuntime = {
      authorize: {
        async authorize(request: UiActionExecutionRequest) {
          if (!pendingObservedBeforeAuthorization) {
            const journals = await findFilesEndingWith(stateRoot, '.jsonl');
            pendingObservedBeforeAuthorization = (await Promise.all(
              journals.map((path) => readFile(path, 'utf8')),
            )).some((content) => content.includes('"type":"begin"'));
          }
          const incidentId = (request.input as { incidentId: string }).incidentId;
          if (incidentId === 'denied') {
            return { decision: 'deny' as const, code: 'permission_denied', reason: 'Denied by policy.' };
          }
          if (incidentId === 'approval') {
            return { decision: 'approval' as const, approvalId: 'approval-1', reason: 'Approval required.' };
          }
          return { decision: 'allow' as const, grants: ['incidents.write'] };
        },
      },
      executor: {
        async execute(
          request: UiActionExecutionRequest,
          executionContext: InvocationContext,
        ): Promise<RuntimeExecResponse> {
          const incidentId = (request.input as { incidentId: string }).incidentId;
          sequence += 1;
          if (incidentId === 'failed') {
            return actionExecutionResponse(
              'failed',
              executionContext,
              `target-${sequence}`,
              undefined,
              { code: 'target_failed', message: 'Target failed.' },
            );
          }
          if (incidentId === 'cancelled') {
            return actionExecutionResponse(
              'cancelled',
              executionContext,
              `target-${sequence}`,
              undefined,
              { code: 'target_cancelled', message: 'Target cancelled.' },
            );
          }
          return actionExecutionResponse(
            'success',
            executionContext,
            `target-${sequence}`,
            { acknowledged: true },
          );
        },
      },
    };
    const first = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const renderId = await compileAndRender(first, context('project-a'));
    const expected = [
      ['success', 'success'],
      ['denied', 'denied'],
      ['approval', 'approval_required'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
    ] as const;

    for (const [incidentId, status] of expected) {
      await expect(first.actionDispatcher!.invoke({
        renderId,
        actionId: 'acknowledge',
        input: { incidentId },
        scope: 'project',
        idempotencyKey: `receipt-${incidentId}`,
      }, context('project-a'))).resolves.toMatchObject({ status });
    }
    expect(pendingObservedBeforeAuthorization).toBe(true);

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const receipts = await restarted.store.listReceipts('project', context('project-a'));
    const forest = buildRuntimeReceiptForest(receipts);
    expect(forest.orphans).toEqual([]);
    expect(forest.roots).toHaveLength(expected.length);
    expect(forest.roots.map((node) => node.receipt.status).sort()).toEqual(
      expected.map(([, status]) => status).sort(),
    );
    for (const root of forest.roots) {
      expect(root.receipt.target).toBe('ui.action.acknowledge');
      expect(root.children).toHaveLength(
        root.receipt.status === 'denied' || root.receipt.status === 'approval_required' ? 0 : 1,
      );
    }
  });

  it('recovers a crash after target success with one root and one deduplicated mutation', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Crash recovery</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const renderId = await compileAndRender(bundle, context('project-a'));
    const targetResults = new Map<string, RuntimeExecResponse>();
    const targetKeys: string[] = [];
    let mutations = 0;
    let targetExecutions = 0;
    const executor = {
      async execute(
        request: UiActionExecutionRequest,
        executionContext: InvocationContext,
      ): Promise<RuntimeExecResponse> {
        targetExecutions += 1;
        const key = String(request.targetIdempotencyKey);
        targetKeys.push(key);
        const replay = targetResults.get(key);
        if (replay) return replay;
        mutations += 1;
        const response = actionExecutionResponse(
          'success',
          executionContext,
          `deduplicated-target-${mutations}`,
          { acknowledged: true },
        );
        targetResults.set(key, response);
        return response;
      },
    };
    let terminalFault = true;
    const faultingJournal: UiActionJournalStore = {
      begin: (key, scope, attempt, current) => bundle.store.begin(key, scope, attempt, current),
      markLeaseLost: (key, scope, receiptId, error, current) =>
        bundle.store.markLeaseLost(key, scope, receiptId, error, current),
      async terminalize(key, scope, receiptId, result, current) {
        if (terminalFault) {
          terminalFault = false;
          throw new Error('fault after target success');
        }
        await bundle.store.terminalize(key, scope, receiptId, result, current);
      },
      close: (key, scope, receiptId, current) =>
        bundle.store.close(key, scope, receiptId, current),
      listReceipts: (scope, current) => bundle.store.listReceipts(scope, current),
    };
    const first = actionDispatcherFor(bundle, executor, faultingJournal, bundle.store);
    const request = actionRequest(renderId, 'crash-after-target');
    await expect(first.invoke(request, context('project-a'))).rejects.toThrow('fault after target success');
    const [journalPath] = await findFilesEndingWith(stateRoot, '.jsonl');
    if (!journalPath) throw new Error('Expected a pending UI action root journal');
    const events = (await readFile(journalPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        type?: string;
        attempt?: { ownerPid?: number };
        [key: string]: unknown;
      });
    const begin = events.find((event) => event.type === 'begin');
    if (!begin?.attempt) throw new Error('Expected a pending UI action begin event');
    begin.attempt.ownerPid = 2_147_483_647;
    await writeFile(
      journalPath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    await expect(
      bundle.store.listReceipts('project', context('project-a')),
    ).resolves.toEqual([]);

    const restarted = actionDispatcherFor(bundle, executor, bundle.store, bundle.store);
    await expect(restarted.invoke(request, context('project-a'))).resolves.toMatchObject({
      status: 'success',
      output: { acknowledged: true },
    });
    expect(targetExecutions).toBe(2);
    expect(mutations).toBe(1);
    expect(new Set(targetKeys).size).toBe(1);
    const forest = buildRuntimeReceiptForest(
      await bundle.store.listReceipts('project', context('project-a')),
    );
    expect(forest.orphans).toEqual([]);
    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.children).toHaveLength(1);
  });

  it('recovers an action-result completion fault without repeating the target effect', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Completion recovery</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const renderId = await compileAndRender(bundle, context('project-a'));
    let targetExecutions = 0;
    const executor = {
      async execute(_request: unknown, executionContext: InvocationContext): Promise<RuntimeExecResponse> {
        targetExecutions += 1;
        return actionExecutionResponse(
          'success',
          executionContext,
          'completion-target',
          { acknowledged: true },
        );
      },
    };
    let completionFault = true;
    const faultingResults: UiActionIdempotencyStore = {
      get: (key, scope, current) => bundle.store.get(key, scope, current),
      put: (key, scope, record, current) => bundle.store.put(key, scope, record, current),
      claim: (key, scope, digest, leaseMs, current) =>
        bundle.store.claim(key, scope, digest, leaseMs, current),
      renew: (key, scope, lease, leaseMs, current) =>
        bundle.store.renew(key, scope, lease, leaseMs, current),
      async complete(key, scope, lease, record, current) {
        if (completionFault) {
          completionFault = false;
          throw new Error('fault before action result completion');
        }
        return bundle.store.complete(key, scope, lease, record, current);
      },
      release: (key, scope, lease, current) =>
        bundle.store.release(key, scope, lease, current),
    };
    const request = actionRequest(renderId, 'completion-fault');
    const first = actionDispatcherFor(bundle, executor, bundle.store, faultingResults);
    await expect(first.invoke(request, context('project-a'))).rejects.toThrow(
      'fault before action result completion',
    );

    const restarted = actionDispatcherFor(bundle, executor, bundle.store, bundle.store);
    await expect(restarted.invoke(request, context('project-a'))).resolves.toMatchObject({
      status: 'success',
      receipt: { replayed: true },
    });
    expect(targetExecutions).toBe(1);
    const forest = buildRuntimeReceiptForest(
      await bundle.store.listReceipts('project', context('project-a')),
    );
    expect(forest.orphans).toEqual([]);
    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.children).toHaveLength(1);
  });

  it('aborts on persistent lease-renewal loss before expiry and prevents contender overlap', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Lease loss</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const renderId = await compileAndRender(bundle, context('project-a'));
    let renewals = 0;
    const failingRenewal: UiActionIdempotencyStore = {
      get: (key, scope, current) => bundle.store.get(key, scope, current),
      put: (key, scope, record, current) => bundle.store.put(key, scope, record, current),
      claim: (key, scope, digest, leaseMs, current) =>
        bundle.store.claim(key, scope, digest, leaseMs, current),
      async renew(key, scope, lease, leaseMs, current) {
        renewals += 1;
        if (renewals === 2) return undefined;
        return bundle.store.renew(key, scope, lease, leaseMs, current);
      },
      complete: (key, scope, lease, record, current) =>
        bundle.store.complete(key, scope, lease, record, current),
      release: (key, scope, lease, current) =>
        bundle.store.release(key, scope, lease, current),
    };
    let targetCalls = 0;
    let activeTargets = 0;
    let maxActiveTargets = 0;
    let firstStartedAt = 0;
    let firstAbortedAt = 0;
    const executor = {
      async execute(_request: unknown, executionContext: InvocationContext): Promise<RuntimeExecResponse> {
        targetCalls += 1;
        const call = targetCalls;
        activeTargets += 1;
        maxActiveTargets = Math.max(maxActiveTargets, activeTargets);
        try {
          if (call === 1) {
            firstStartedAt = Date.now();
            await waitForAbort(executionContext, () => {
              firstAbortedAt = Date.now();
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return actionExecutionResponse(
            'success',
            executionContext,
            `lease-target-${call}`,
            { acknowledged: true },
          );
        } finally {
          activeTargets -= 1;
        }
      },
    };
    const first = actionDispatcherFor(bundle, executor, bundle.store, failingRenewal, {
      idempotencyLeaseMs: 300,
      idempotencyPollMs: 5,
    });
    const second = actionDispatcherFor(bundle, executor, bundle.store, failingRenewal, {
      idempotencyLeaseMs: 300,
      idempotencyPollMs: 5,
    });
    const request = actionRequest(renderId, 'lease-loss');
    const firstCall = first.invoke(request, context('project-a'));
    const calls = [firstCall];
    try {
      await vi.waitFor(() => expect(targetCalls).toBe(1), { timeout: 8_000 });
      const secondCall = second.invoke(request, context('project-a'));
      calls.push(secondCall);
      const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

      expect(firstResult).toMatchObject({
        status: 'failed',
        error: { code: 'ui_action_lease_lost' },
      });
      expect(secondResult).toMatchObject({ status: 'success' });
      expect(firstAbortedAt - firstStartedAt).toBeGreaterThanOrEqual(0);
      expect(firstAbortedAt - firstStartedAt).toBeLessThan(300);
      expect(maxActiveTargets).toBe(1);
      expect(targetCalls).toBe(2);
    } finally {
      await Promise.allSettled(calls);
    }
  }, 40_000);

  it('serializes one backend execution across dispatcher instances sharing durable storage', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Atomic</p>}' });
    const stateRoot = join(workspacePath, '.state');
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> => {
      await blocked;
      return executionResponse({ acknowledged: true });
    });
    const actionRuntime = {
      authorize: { authorize: () => ({ decision: 'allow' as const, grants: ['incidents.write'] }) },
      executor: { execute },
      idempotencyLeaseMs: 90,
      idempotencyPollMs: 5,
    };
    const first = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const renderId = await compileAndRender(first, context('project-a'));
    const second = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const request = {
      renderId,
      actionId: 'acknowledge',
      input: { incidentId: 'inc-atomic' },
      scope: 'project' as const,
      idempotencyKey: 'one-backend-call',
    };

    const firstCall = first.actionDispatcher!.invoke(request, context('project-a'));
    const calls = [firstCall];
    try {
      // Filesystem contention on a busy Windows host can legitimately delay the
      // durable claim beyond Vitest's one-second waitFor default. Keep this
      // below the store's ten-second transaction deadline.
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 8_000 });
      const secondCall = second.actionDispatcher!.invoke(request, context('project-a'));
      calls.push(secondCall);
      // Wait beyond the original lease: heartbeats must preserve ownership.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(execute).toHaveBeenCalledTimes(1);
      unblock();
      const results = await Promise.all(calls);
      expect(results.map((result) => result.receipt.replayed ?? false).sort()).toEqual([false, true]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      // Never let a failed observation orphan the blocked action while the test
      // fixture removes its storage root; doing so obscures the first failure
      // with a secondary transaction-lock error.
      unblock();
      await Promise.allSettled(calls);
    }
  });

  it('keeps renewing ownership while successful terminal persistence is blocked', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Persistence heartbeat</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const renderId = await compileAndRender(bundle, context('project-a'));
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> =>
      executionResponse({ acknowledged: true }));
    let terminalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { terminalEntered = resolve; });
    let releaseTerminal!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const delayedJournal: UiActionJournalStore = {
      begin: (key, scope, attempt, current) => bundle.store.begin(key, scope, attempt, current),
      markLeaseLost: (key, scope, receiptId, error, current) =>
        bundle.store.markLeaseLost(key, scope, receiptId, error, current),
      async terminalize(key, scope, receiptId, result, current) {
        terminalEntered();
        await blocked;
        return bundle.store.terminalize(key, scope, receiptId, result, current);
      },
      close: (key, scope, receiptId, current) =>
        bundle.store.close(key, scope, receiptId, current),
      listReceipts: (scope, current) => bundle.store.listReceipts(scope, current),
    };
    const options = { idempotencyLeaseMs: 300, idempotencyPollMs: 5 };
    const first = actionDispatcherFor(bundle, { execute }, delayedJournal, bundle.store, options);
    const second = actionDispatcherFor(bundle, { execute }, bundle.store, bundle.store, options);
    const request = actionRequest(renderId, 'slow-terminal-persistence');
    const firstCall = first.invoke(request, context('project-a'));
    await entered;

    const [journalPath] = await findFilesEndingWith(stateRoot, '.jsonl');
    if (!journalPath) throw new Error('Expected a pending UI action root journal');
    const events = (await readFile(journalPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        type?: string;
        attempt?: { ownerPid?: number };
        [key: string]: unknown;
      });
    const begin = events.find((event) => event.type === 'begin');
    if (!begin?.attempt) throw new Error('Expected a pending UI action begin event');
    begin.attempt.ownerPid = 2_147_483_647;
    await writeFile(
      journalPath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    const key = actionIdempotencyKey(
      renderId,
      'acknowledge',
      '1.0.0',
      'project',
      'slow-terminal-persistence',
    );
    const [leasePath] = await findNamedFiles(stateRoot, `${key}.json`);
    if (!leasePath) throw new Error('Expected the terminal-persistence ownership lease');
    const beforeRenewal = JSON.parse(await readFile(leasePath, 'utf8')) as { expiresAt: string };

    const contenderCalls = Array.from({ length: 3 }, () =>
      second.invoke(request, context('project-a')));
    const calls = [firstCall, ...contenderCalls];
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterRenewal = JSON.parse(await readFile(leasePath, 'utf8')) as { expiresAt: string };
      expect(Date.parse(afterRenewal.expiresAt)).toBeGreaterThan(Date.parse(beforeRenewal.expiresAt));
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(execute).toHaveBeenCalledTimes(1);
      releaseTerminal();
      const results = await Promise.all(calls);
      expect(results.map((result) => result.receipt.replayed ?? false).sort()).toEqual([
        false,
        true,
        true,
        true,
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      releaseTerminal();
      await Promise.allSettled(calls);
    }
  });

  it('rejects a mismatched in-flight digest and recovers expired ownership after PID reuse', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Recovery</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const execute = vi.fn(async (): Promise<RuntimeExecResponse> => executionResponse({ acknowledged: true }));
    const actionRuntime = {
      authorize: { authorize: () => ({ decision: 'allow' as const, grants: ['incidents.write'] }) },
      executor: { execute },
      idempotencyLeaseMs: 100,
      idempotencyPollMs: 5,
    };
    const abandoned = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    const renderId = await compileAndRender(abandoned, context('project-a'));
    const action = application().actions[0]!;
    const request = {
      renderId,
      actionId: action.id,
      input: { incidentId: 'inc-recovery' },
      scope: 'project' as const,
      idempotencyKey: 'recover-stale',
    };
    const key = actionIdempotencyKey(renderId, action.id, action.version, request.scope, request.idempotencyKey);
    const digest = actionRequestDigest({ renderId, action, input: request.input, scope: request.scope, idempotencyKey: request.idempotencyKey });
    await expect(abandoned.store.claim(key, request.scope, digest, 10, context('project-a'))).resolves.toMatchObject({ status: 'acquired' });
    const [leasePath] = await findNamedFiles(stateRoot, `${key}.json`);
    if (!leasePath) throw new Error('Expected an abandoned lease file');
    const scopeRoot = dirname(dirname(leasePath));
    const transactionPath = join(scopeRoot, 'action-locks', `${key}.lock`);
    await mkdir(dirname(transactionPath), { recursive: true });
    await writeFile(transactionPath, `${JSON.stringify({
      ownerId: '00000000-0000-4000-8000-000000000099',
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:00:01.000Z',
    })}\n`, 'utf8');

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot, actionRuntime });
    await expect(restarted.actionDispatcher!.invoke(
      { ...request, input: { incidentId: 'different' } },
      context('project-a'),
    )).rejects.toThrow('reused with a different request');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(restarted.actionDispatcher!.invoke(request, context('project-a'))).resolves.toMatchObject({
      status: 'success',
      output: { acknowledged: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an unkeyed crashed root after lease expiry despite PID reuse', async () => {
    const workspacePath = await workspace({});
    const stateRoot = join(workspacePath, '.state');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const current = context('project-a');
    const key = '9'.repeat(64);
    const requestDigest = '8'.repeat(64);
    const claim = await bundle.store.claim(key, 'project', requestDigest, 10, current);
    if (claim.status !== 'acquired') throw new Error(`Expected acquired lease, received ${claim.status}`);
    const receiptId = 'unkeyed-crash-receipt';
    await bundle.store.begin(key, 'project', {
      receiptId,
      executionId: receiptId,
      lineage: { rootExecutionId: receiptId, depth: 0 },
      renderId: '7'.repeat(64),
      actionId: 'unkeyed-crash',
      actionVersion: '1.0.0',
      target: { kind: 'capability', capability: 'incidents.acknowledge' },
      scope: 'project',
      principalId: current.principal.id,
      invocationScope: current.scope,
      requestDigest,
      targetIdempotencyKey: '6'.repeat(64),
      startedAt: new Date().toISOString(),
      ownerId: claim.lease.ownerId,
      ownerPid: process.pid,
      leaseExpiresAt: claim.lease.expiresAt,
      phase: 'pending',
    }, current);
    const [leasePath] = await findNamedFiles(stateRoot, `${key}.json`);
    if (!leasePath) throw new Error('Expected an unkeyed ownership lease');
    const persistedLease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await bundle.store.release(key, 'project', claim.lease, current);
    persistedLease.expiresAt = '2000-01-01T00:00:00.000Z';
    persistedLease.ownerPid = process.pid;
    await writeFile(leasePath, `${JSON.stringify(persistedLease, null, 2)}\n`, 'utf8');

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot });
    await expect(restarted.store.listReceipts('project', current)).resolves.toContainEqual(
      expect.objectContaining({
        receiptId,
        status: 'failed',
        permission: expect.objectContaining({ code: 'ui_action_interrupted' }),
      }),
    );
    expect(await findNamedFiles(stateRoot, `${key}.json`)).toHaveLength(0);
  });

  it('does not let an approval-required target poison an idempotency key', async () => {
    const idempotencyStore = new MemoryIdempotencyStore();
    const execute = vi
      .fn<() => Promise<RuntimeExecResponse>>()
      .mockResolvedValueOnce({
        protocolVersion: '1.0.0',
        status: 'approval_required',
        approval: {
          decision: 'approval',
          approvalId: 'approve-target',
          reason: 'Target capability requires approval.',
        },
        receipt: {
          protocolVersion: '1.0.0',
          receiptId: 'target-approval-receipt',
          executionId: 'target-approval-execution',
          target: 'incidents.acknowledge',
          principalId: context('project-a').principal.id,
          lineage: { rootExecutionId: 'target-approval-execution', depth: 0 },
          status: 'approval_required',
          startedAt: '2026-08-01T00:00:00.000Z',
          completedAt: '2026-08-01T00:00:00.000Z',
          durationMs: 0,
        },
      })
      .mockResolvedValue(executionResponse({ acknowledged: true }));
    const dispatcher = new UiActionDispatcher({
      loadApplication: async () => application(),
      authorize: { authorize: () => ({ decision: 'allow', grants: ['incidents.write'] }) },
      executor: { execute },
      idempotencyStore,
    });
    const request = {
      renderId: 'd'.repeat(64),
      actionId: 'acknowledge',
      input: { incidentId: 'inc-approval' },
      scope: 'project' as const,
      idempotencyKey: 'approval-retry',
    };

    await expect(dispatcher.invoke(request, context('project-a'))).resolves.toMatchObject({
      status: 'approval_required',
      approval: { approvalId: 'approve-target' },
    });
    expect(idempotencyStore.size).toBe(0);
    const approved = await dispatcher.invoke(
      { ...request, approval: { approvalId: 'approve-target' } },
      context('project-a'),
    );
    expect(approved).toMatchObject({ status: 'success', output: { acknowledged: true } });
    await expect(dispatcher.invoke(request, context('project-a'))).resolves.toMatchObject({
      status: 'success',
      receipt: { replayed: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('portable restoration and renderer versioning', () => {
  it('reopens a cached render 100 times without cross-project local-state leakage', async () => {
    const workspacePath = await workspace({ 'App.tsx': 'export default function App(){return <p>Persistent</p>}' });
    const stateRoot = join(workspacePath, '.state');
    const first = createReactUiCapabilities({ workspacePath, stateRoot });
    const renderIdA = await compileAndRender(first, context('project-a'));
    const renderIdB = await compileAndRender(first, context('project-b'));
    expect(renderIdA).toBe(renderIdB);
    await first.store.mutateRenderState(renderIdA, { operation: 'set', key: 'view', value: 'alpha', expectedVersion: 0 }, context('project-a'));
    await first.store.mutateRenderState(renderIdB, { operation: 'set', key: 'view', value: 'beta', expectedVersion: 0 }, context('project-b'));

    const restarted = createReactUiCapabilities({ workspacePath, stateRoot });
    for (let batchStart = 0; batchStart < 100; batchStart += 10) {
      await Promise.all(Array.from({ length: 10 }, () => [
        expect(restarted.store.getApplicationState(renderIdA, context('project-a'))).resolves.toMatchObject({ local: { version: 1, values: { view: 'alpha' } } }),
        expect(restarted.store.getApplicationState(renderIdB, context('project-b'))).resolves.toMatchObject({ local: { version: 1, values: { view: 'beta' } } }),
      ]).flat());
    }
  });

  it('uses an explicitly versioned renderer resource and standards-first bridge methods', () => {
    expect(REACT_UI_TEMPLATE_URI).toMatch(/runtime-renderer\/1\.4\.0\/index\.html$/);
    const html = reactUiTemplateContent().text;
    expect(html).toContain("['inline','fullscreen','pip']");
    expect(html).toContain('ui/notifications/size-changed');
    expect(html).toContain('ui/notifications/teardown');
    expect(html).toContain('hostInitialization');
    expect(html).toContain('openaiExtensionMethods');
    expect(html).toContain('marshal/extensions/call');
    expect(html).toContain('function dispatchBoundTool(data)');
    expect(html).toContain("params.name===declaredTool");
    expect(html).toContain('renderId:currentRenderId,toolId:args.toolId');
    expect(html).toContain('Only render-declared actions and tools may be invoked.');
    expect(html).toContain("['ui/message','ui/update-model-context','ui/open-link']");
    expect(html).toContain('Display mode is not declared by this render.');
    expect(html).not.toContain("if(data.method==='marshal/storage'){requestState(data.params);return;}parent.postMessage(data,'*')");
    expect(REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS).toBeLessThan(5_000);
    expect(html).toContain(`},${REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS})`);
    expect(html).toContain('fallbackSummary');
    expect(html).toContain("fallback.summary==='string'");
  });
});

function application(): UiApplicationManifest {
  return {
    version: '1.0.0',
    presentationModes: ['inline', 'fullscreen', 'pip'],
    actions: [{
      id: 'acknowledge', version: '1.0.0',
      target: { kind: 'capability', capability: 'incidents.acknowledge' },
      inputSchema: { type: 'object', properties: { incidentId: { type: 'string' } }, required: ['incidentId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { acknowledged: { type: 'boolean' } }, required: ['acknowledged'], additionalProperties: false },
      allowedScopes: ['project'], requiredPermissions: ['incidents.write'], risk: 'write', idempotency: 'required',
    }],
    tools: [],
    localState: { scope: 'project', schemaVersion: '1.0.0' },
    authoritativeState: { capability: 'incidents.get', resourceId: 'incident-board', version: '7' },
  };
}

function toolApplication(): UiApplicationManifest {
  return {
    ...application(),
    actions: [],
    tools: [{
      id: 'incident',
      name: 'incidents.get',
      inputSchema: {
        type: 'object', properties: { incidentId: { type: 'string' } },
        required: ['incidentId'], additionalProperties: false,
      },
      outputSchema: {
        type: 'object', properties: { status: { type: 'string' }, incidentId: { type: 'string' } },
        required: ['status'], additionalProperties: true,
      },
    }],
  };
}

class TestTransport implements UiProtocolTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(message: UiProtocolMessage) => void>();
  private readonly responders = new Map<string, (params: unknown) => unknown>();
  constructor(private readonly initializeResult: unknown) {}
  respond(method: string, callback: (params: unknown) => unknown): void { this.responders.set(method, callback); }
  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === 'ui/initialize') return this.initializeResult as TResult;
    const responder = this.responders.get(method);
    if (!responder) return {} as TResult;
    return responder(params) as TResult;
  }
  notify(method: string, params: unknown): void { this.notifications.push({ method, params }); }
  subscribe(listener: (message: UiProtocolMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(message: UiProtocolMessage): void { for (const listener of [...this.listeners]) listener(message); }
}

async function compileAndRender(bundle: ReturnType<typeof createReactUiCapabilities>, current: InvocationContext): Promise<string> {
  const compiled = await bundle.provider.invoke('ui.compile', { entryPath: 'App.tsx', title: 'Persistent' }, current);
  const componentId = String(((compiled.output as Record<string, unknown>).component as Record<string, unknown>).id);
  const rendered = await bundle.provider.invoke('ui.render', { componentId, props: {}, fallback: { summary: 'Persistent' }, application: application() }, current);
  return String(((rendered.output as Record<string, unknown>).render as Record<string, unknown>).id);
}

function context(projectId: string): InvocationContext {
  return { principal: { id: 'agent', kind: 'agent' }, scope: { workspaceId: 'workspace', projectId, sessionId: 'session' } };
}

function executionResponse(output: unknown): RuntimeExecResponse {
  return {
    protocolVersion: '1.0.0', status: 'success', result: { output },
    receipt: {
      protocolVersion: '1.0.0', receiptId: 'target-receipt', executionId: 'execution', target: 'incidents.acknowledge',
      principalId: 'agent', lineage: { rootExecutionId: 'execution', depth: 0 }, status: 'success', startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.000Z', durationMs: 0,
    },
  };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-ui-contract-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === name) found.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return found;
}

async function findFilesEndingWith(root: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(suffix)) found.push(path);
    }
  }
  await visit(root);
  return found;
}

function actionDispatcherFor(
  bundle: ReturnType<typeof createReactUiCapabilities>,
  executor: UiActionExecutionPort,
  journalStore: UiActionJournalStore,
  idempotencyStore: UiActionIdempotencyStore,
  options: Pick<UiActionDispatcherOptions, 'idempotencyLeaseMs' | 'idempotencyPollMs'> = {},
): UiActionDispatcher {
  return new UiActionDispatcher({
    loadApplication: async (renderId, current) =>
      (await bundle.store.getRender(renderId, current)).application,
    authorize: {
      authorize: () => ({ decision: 'allow', grants: ['incidents.write'] }),
    },
    executor,
    journalStore,
    idempotencyStore,
    ...options,
  });
}

function actionRequest(renderId: string, idempotencyKey: string) {
  return {
    renderId,
    actionId: 'acknowledge',
    input: { incidentId: idempotencyKey },
    scope: 'project' as const,
    idempotencyKey,
  };
}

function actionExecutionResponse(
  status: RuntimeExecResponse['status'],
  current: InvocationContext,
  executionId: string,
  output?: unknown,
  error?: RuntimeExecResponse['error'],
): RuntimeExecResponse {
  const now = new Date().toISOString();
  return {
    protocolVersion: '1.0.0',
    status,
    ...(output === undefined ? {} : { result: { output } }),
    ...(error ? { error } : {}),
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: `${executionId}-receipt`,
      executionId,
      target: 'incidents.acknowledge',
      principalId: current.principal.id,
      identity: current.identity,
      scope: current.scope,
      lineage: { rootExecutionId: executionId, depth: 0 },
      status,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  };
}

async function waitForAbort(
  context: InvocationContext,
  onAbort: () => void,
): Promise<void> {
  const signal = context.signal;
  if (!signal) throw new Error('Expected the UI action target to receive an abort signal');
  if (signal.aborted) {
    onAbort();
    return;
  }
  if (
    typeof (signal as AbortSignal).addEventListener !== 'function' ||
    typeof (signal as AbortSignal).removeEventListener !== 'function'
  ) {
    while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
    onAbort();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const evented = signal as AbortSignal;
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for lease-loss cancellation')),
      1_000,
    );
    evented.addEventListener('abort', () => {
      clearTimeout(timeout);
      onAbort();
      resolve();
    }, { once: true });
  });
}

class MemoryIdempotencyStore implements UiActionIdempotencyStore {
  private readonly records = new Map<string, UiActionIdempotencyRecord>();
  private readonly leases = new Map<string, UiActionIdempotencyLease>();
  private sequence = 0;
  get size(): number { return this.records.size; }
  get leaseSize(): number { return this.leases.size; }
  async get(key: string): Promise<UiActionIdempotencyRecord | undefined> { return this.records.get(key); }
  async put(key: string, _scope: UiStateScope, record: UiActionIdempotencyRecord): Promise<void> { this.records.set(key, record); }
  async claim(
    key: string,
    _scope: UiStateScope,
    requestDigest: string,
    leaseMs: number,
  ): Promise<UiActionIdempotencyClaim> {
    const record = this.records.get(key);
    if (record) {
      if (record.requestDigest !== requestDigest) throw new Error('UI action idempotency key was reused with a different request');
      return { status: 'replay', record };
    }
    const current = this.leases.get(key);
    if (current && Date.parse(current.expiresAt) > Date.now()) {
      if (current.requestDigest !== requestDigest) throw new Error('UI action idempotency key was reused with a different request');
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
