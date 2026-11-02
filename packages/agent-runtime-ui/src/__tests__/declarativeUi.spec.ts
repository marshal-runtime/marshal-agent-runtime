import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InvocationContext,
  RuntimeExecResponse,
  RuntimeExecutionStatus,
} from '@marshal/agent-runtime-core';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeclarativeUiMcpAppsResourceAdapter,
  DeclarativeUiProvider,
  DeclarativeUiStore,
  mcpAppsTemplateContent,
  renderMcpAppsHtml,
  type DeclarativeUiDocument,
  type DeclarativeUiStoreOptions,
  type UiArtifact,
  uiDocumentDigest,
} from '../declarative/index.js';

const roots: string[] = [];
const windows: Window[] = [];
const invocationContext: InvocationContext = {
  principal: { id: 'agent', kind: 'agent' },
  scope: {
    workspaceId: 'workspace',
    projectId: 'project',
    sessionId: 'session',
  },
};

afterEach(async () => {
  for (const window of windows.splice(0)) window.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('declarative UI revision and action runtime', () => {
  it('binds stale resources and actions to their immutable revision and replays mutations once', async () => {
    const root = await temporaryRoot();
    const invoke = vi.fn(async (operation: string, input: Record<string, unknown>) =>
      runtimeResponse('success', { operation, input }),
    );
    const first = runtime(root, invoke);
    const created = outputArtifact(
      await first.provider.invoke(
        'ui.artifacts.create',
        { document: actionDocument('Revision one', 'memory.write.v1', 1, true) },
        invocationContext,
      ),
    );
    const updated = outputArtifact(
      await first.provider.invoke(
        'ui.artifacts.update',
        {
          artifactId: created.id,
          expectedRevision: created.revision,
          document: actionDocument('Revision two', 'memory.write.v2', 2, false),
        },
        invocationContext,
      ),
    );

    const staleResource = await first.resources.readResource(
      created.resourceUri,
      invocationContext,
    );
    expect(staleResource.text).toContain('Revision one');
    expect(staleResource.text).not.toContain('Revision two');
    await expect(
      first.provider.invoke(
        'ui.actions.invoke',
        {
          artifactId: created.id,
          revision: created.revision,
          documentDigest: updated.documentDigest,
          actionId: 'save',
          event: { value: 'old' },
          idempotencyKey: 'stale-mismatch',
          confirmed: true,
        },
        invocationContext,
      ),
    ).rejects.toThrow('document digest');

    const request = {
      artifactId: created.id,
      revision: created.revision,
      documentDigest: created.documentDigest,
      actionId: 'save',
      event: { value: 'old' },
      idempotencyKey: 'save-revision-one',
    };
    const confirmation = await first.provider.invoke(
      'ui.actions.invoke',
      request,
      invocationContext,
    );
    expect(confirmation.output).toMatchObject({
      status: 'confirmation_required',
      revision: 1,
      documentDigest: created.documentDigest,
    });

    expect(invoke).not.toHaveBeenCalled();

    const completed = await first.provider.invoke(
      'ui.actions.invoke',
      { ...request, confirmed: true },
      invocationContext,
    );
    expect(completed.output).toMatchObject({
      status: 'completed',
      revision: 1,
      operation: 'memory.write.v1',
      output: {
        operation: 'memory.write.v1',
        input: { revision: 1, value: 'old' },
      },
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    const restarted = runtime(root, invoke);
    const replayed = await restarted.provider.invoke(
      'ui.actions.invoke',
      { ...request, confirmed: true },
      invocationContext,
    );
    expect(replayed.output).toEqual(completed.output);
    expect(replayed.receipt).toMatchObject({ replayed: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      restarted.provider.invoke(
        'ui.actions.invoke',
        {
          ...request,
          confirmed: true,
          event: { value: 'changed' },
        },
        invocationContext,
      ),
    ).rejects.toThrow('reused with a different request');
  });

  it('canonicalizes optional undefined fields and repairs an orphan revision before later updates', async () => {
    const root = await temporaryRoot();
    const store = new DeclarativeUiStore({ storageRoot: root });
    const created = await store.create(
      {
        ...actionDocument('Revision one', 'memory.write', 1, false),
        description: undefined,
      },
      invocationContext,
    );
    const updated = await store.update(
      created.id,
      actionDocument('Revision two', 'memory.write', 2, false),
      invocationContext,
      1,
    );
    const third = await store.update(
      created.id,
      actionDocument('Revision three', 'memory.write', 3, false),
      invocationContext,
      2,
    );
    const latestPath = join(
      root,
      'scopes',
      created.scopeKey,
      'ui',
      `${created.id}.json`,
    );
    await writeFile(latestPath, `${JSON.stringify(created, null, 2)}\n`, 'utf8');

    const reconstructed = new DeclarativeUiStore({ storageRoot: root });
    await expect(reconstructed.get(created.id, invocationContext)).resolves.toEqual(third);
    await expect(
      reconstructed.update(
        created.id,
        actionDocument('Revision four', 'memory.write', 4, false),
        invocationContext,
        3,
      ),
    ).resolves.toMatchObject({ revision: 4 });
    expect(updated.revision).toBe(2);
  });

  it('publishes the same scalar-only event constraints enforced at runtime', () => {
    const provider = new DeclarativeUiProvider({
      store: {} as DeclarativeUiStore,
      resources: {} as DeclarativeUiMcpAppsResourceAdapter,
    });
    const inputSchema = provider.get('ui.actions.invoke')?.inputSchema as {
      properties?: {
        event?: {
          propertyNames?: { pattern?: string };
          additionalProperties?: {
            oneOf?: Array<Record<string, unknown>>;
          };
        };
      };
    };
    expect(inputSchema.properties?.event?.propertyNames?.pattern).toContain('__proto__');
    expect(inputSchema.properties?.event?.additionalProperties?.oneOf).toEqual([
      { type: 'string', maxLength: 4_000 },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      {
        type: 'array',
        maxItems: 100,
        items: {
          oneOf: [
            { type: 'string', maxLength: 4_000 },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
      },
    ]);
  });

  it('enforces artifact, revision, and idempotency capacity before successful writes or effects', async () => {
    const artifactRoot = await temporaryRoot();
    const artifactStore = new DeclarativeUiStore({
      storageRoot: artifactRoot,
      maxArtifactsPerScope: 1,
      maxRevisionsPerArtifact: 2,
    });
    const created = await Promise.allSettled([
      artifactStore.create(actionDocument('First', 'memory.write', 1, false), invocationContext),
      artifactStore.create(actionDocument('Second', 'memory.write', 1, false), invocationContext),
    ]);
    expect(created.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(created.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const only = (await artifactStore.list(invocationContext))[0]!;
    await artifactStore.update(
      only.id,
      actionDocument('Revision two', 'memory.write', 2, false),
      invocationContext,
      1,
    );
    await expect(
      artifactStore.update(
        only.id,
        actionDocument('Revision three', 'memory.write', 3, false),
        invocationContext,
        2,
      ),
    ).rejects.toThrow('revision history limit');
    await expect(artifactStore.get(only.id, invocationContext)).resolves.toMatchObject({
      revision: 2,
    });

    const actionRoot = await temporaryRoot();
    const invoke = vi.fn(async (_operation: string, input: Record<string, unknown>) =>
      runtimeResponse('success', input),
    );
    const bundle = runtime(actionRoot, invoke, { maxActionResultsPerScope: 1 });
    const artifact = outputArtifact(
      await bundle.provider.invoke(
        'ui.artifacts.create',
        { document: actionDocument('Action capacity', 'memory.write', 1, false) },
        invocationContext,
      ),
    );
    const actionRequest = {
      artifactId: artifact.id,
      revision: artifact.revision,
      documentDigest: artifact.documentDigest,
      actionId: 'save',
      event: { value: 'first' },
    };
    await bundle.provider.invoke(
      'ui.actions.invoke',
      { ...actionRequest, idempotencyKey: 'capacity-one' },
      invocationContext,
    );
    await expect(
      bundle.provider.invoke(
        'ui.actions.invoke',
        {
          ...actionRequest,
          event: { value: 'second' },
          idempotencyKey: 'capacity-two',
        },
        invocationContext,
      ),
    ).rejects.toThrow('scope limit reached before execution');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses locale-independent document digests and accepts scalar-array action inputs', async () => {
    const left = actionDocument('Digest', 'memory.write', 1, false);
    left.actions![0]!.input = { ai: 1, aI: 2, Ai: 3, AI: 4 };
    const right = actionDocument('Digest', 'memory.write', 1, false);
    right.actions![0]!.input = { AI: 4, Ai: 3, aI: 2, ai: 1 };
    expect(uiDocumentDigest(left)).toBe(uiDocumentDigest(right));

    const root = await temporaryRoot();
    const invoke = vi.fn(async (_operation: string, input: Record<string, unknown>) =>
      runtimeResponse('success', input),
    );
    const bundle = runtime(root, invoke);
    const document = actionDocument('Arrays', 'memory.write', 1, false);
    document.actions![0]!.input = { values: [1, 2] };
    const artifact = outputArtifact(
      await bundle.provider.invoke(
        'ui.artifacts.create',
        { document },
        invocationContext,
      ),
    );
    await expect(
      bundle.provider.invoke(
        'ui.actions.invoke',
        {
          artifactId: artifact.id,
          revision: artifact.revision,
          documentDigest: artifact.documentDigest,
          actionId: 'save',
          event: {},
          idempotencyKey: 'scalar-array',
        },
        invocationContext,
      ),
    ).resolves.toMatchObject({
      output: { status: 'completed', output: { values: [1, 2] } },
    });
    await expect(
      bundle.provider.invoke(
        'ui.actions.invoke',
        {
          artifactId: artifact.id,
          revision: artifact.revision,
          documentDigest: artifact.documentDigest,
          actionId: 'save',
          event: { value: 'x'.repeat(4_001) },
          idempotencyKey: 'oversized-event',
        },
        invocationContext,
      ),
    ).rejects.toThrow('4000');
  });

  it.each([
    ['denied', 'denied', undefined],
    ['cancelled', 'cancelled', undefined],
    ['approval_required', 'approval_required', undefined],
    ['nested-failed', 'success', { status: 'failed', error: { code: 'nested', message: 'Nested failure' } }],
  ] as const)(
    'surfaces %s as a typed non-success action result',
    async (operation, runtimeStatus, nestedOutput) => {
      const root = await temporaryRoot();
      const invoke = vi.fn(async () =>
        runtimeResponse(
          runtimeStatus,
          nestedOutput,
          runtimeStatus === 'approval_required'
            ? { approval: { decision: 'approval', reason: 'Approve this action' } }
            : runtimeStatus === 'success'
              ? {}
              : { error: { code: runtimeStatus, message: `Action ${runtimeStatus}` } },
        ),
      );
      const bundle = runtime(root, invoke);
      const artifact = outputArtifact(
        await bundle.provider.invoke(
          'ui.artifacts.create',
          { document: actionDocument('Status', operation, 1, false) },
          invocationContext,
        ),
      );
      const result = await bundle.provider.invoke(
        'ui.actions.invoke',
        {
          artifactId: artifact.id,
          revision: artifact.revision,
          documentDigest: artifact.documentDigest,
          actionId: 'save',
          event: {},
          idempotencyKey: `status-${operation}`,
        },
        invocationContext,
      );

      expect(result.output).toMatchObject({
        status: operation === 'nested-failed' ? 'failed' : runtimeStatus,
        artifactId: artifact.id,
        revision: artifact.revision,
        documentDigest: artifact.documentDigest,
      });
    },
  );

  it('surfaces an MCP isError envelope as a typed failed action result', async () => {
    const root = await temporaryRoot();
    const invoke = vi.fn(async () => ({
      isError: true,
      structuredContent: {
        error: { code: 'mcp_rejected', message: 'MCP rejected the mutation.' },
      },
    }));
    const bundle = runtime(root, invoke);
    const artifact = outputArtifact(
      await bundle.provider.invoke(
        'ui.artifacts.create',
        { document: actionDocument('MCP error', 'mcp-error', 1, false) },
        invocationContext,
      ),
    );

    await expect(bundle.provider.invoke(
      'ui.actions.invoke',
      {
        artifactId: artifact.id,
        revision: artifact.revision,
        documentDigest: artifact.documentDigest,
        actionId: 'save',
        event: {},
        idempotencyKey: 'mcp-error',
      },
      invocationContext,
    )).resolves.toMatchObject({
      output: {
        status: 'failed',
        error: { code: 'mcp_rejected', message: 'MCP rejected the mutation.' },
      },
    });
  });
});

describe('declarative MCP Apps renderer', () => {
  it('uses standards-only sizing and preserves typed select scalar values', async () => {
    const artifact = rendererArtifact({
      protocolVersion: '1.0.0',
      title: 'Typed select',
      root: {
        type: 'stack',
        id: 'root',
        children: [
          {
            type: 'select',
            id: 'choice',
            name: 'choice',
            label: 'Choice',
            options: [
              { label: 'zero', value: 0 },
              { label: 'false', value: false },
              { label: 'null', value: null },
              { label: 'empty string', value: '' },
              { label: 'string zero', value: '0' },
            ],
          },
          { type: 'button', id: 'submit', label: 'Submit', actionId: 'submit' },
        ],
      },
      actions: [{ id: 'submit', operation: 'memory.write', eventMap: { choice: 'choice' } }],
    });
    const template = mcpAppsTemplateContent();
    expect(template.text).not.toContain('window.openai');
    expect(template.text).not.toContain('notifyIntrinsicHeight');
    expect(renderMcpAppsHtml(artifact)).not.toContain('window.openai');

    const mounted = mountTemplate();
    mounted.initialize();
    mounted.show(artifact);
    expect(mounted.messages()).toContainEqual(
      expect.objectContaining({ method: 'ui/notifications/size-changed' }),
    );
    const select = mounted.outer.document.querySelector<HTMLSelectElement>('select')!;
    const button = mounted.outer.document.querySelector<HTMLButtonElement>('[data-action="submit"]')!;
    const changedIndices: number[] = [];
    select.addEventListener('change', () => changedIndices.push(select.selectedIndex));
    const staleSelectedOption = select.options[0]!;
    Object.defineProperty(select, 'selectedOptions', {
      configurable: true,
      get: () => [staleSelectedOption],
    });

    for (const [index, expected] of [0, false, null, '', '0'].entries()) {
      select.selectedIndex = index;
      select.dispatchEvent(new mounted.outer.Event('change', { bubbles: true }));
      button.click();
      const call = mounted.lastToolCall();
      expect(actionInput(call).event).toEqual({ choice: expected });
      mounted.respond(call.id, actionCallResult({ status: 'completed', output: null }));
      await flush();
    }
    expect(changedIndices).toEqual([0, 1, 2, 3, 4]);
  });

  it('shows explicit confirmation and retries with confirmed true and the same operation key', async () => {
    const mounted = mountTemplate();
    mounted.initialize();
    mounted.show(
      rendererArtifact(actionDocument('Confirm', 'memory.write', 1, true)),
    );
    const button = mounted.outer.document.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    button.click();
    const first = mounted.lastToolCall();
    const firstInput = actionInput(first);
    expect(firstInput.confirmed).toBeUndefined();

    mounted.respond(
      first.id,
      actionCallResult({
        status: 'confirmation_required',
        confirmation: { title: 'Save', message: 'Persist the change?' },
      }),
    );
    await flush();
    const dialog = mounted.outer.document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Persist the change?');
    dialog.querySelector<HTMLButtonElement>('button.primary')!.click();
    const second = mounted.lastToolCall();
    const secondInput = actionInput(second);
    expect(secondInput.confirmed).toBe(true);
    expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);

    mounted.respond(second.id, actionCallResult({ status: 'completed', output: { saved: true } }));
    await flush();
    expect(button.dataset.status).toBe('completed');
    expect(mounted.outer.document.querySelector('[role="status"]')?.textContent).toContain(
      'completed',
    );
  });

  it.each([
    ['MCP error', { isError: true, structuredContent: { error: 'MCP rejected the call' } }, 'failed'],
    [
      'outer denial',
      { structuredContent: { status: 'denied', error: { message: 'Denied by runtime' } } },
      'denied',
    ],
    [
      'output approval',
      actionCallResult({ status: 'approval_required', approval: { reason: 'Approval needed' } }),
      'approval_required',
    ],
    ['output cancellation', actionCallResult({ status: 'cancelled' }), 'cancelled'],
    [
      'output failure',
      actionCallResult({ status: 'failed', error: { message: 'Mutation failed' } }),
      'failed',
    ],
  ] as const)('decodes %s as %s', async (_label, response, expectedStatus) => {
    const mounted = mountTemplate();
    mounted.initialize();
    mounted.show(rendererArtifact(actionDocument('Status', 'memory.write', 1, false)));
    const button = mounted.outer.document.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    button.click();
    const call = mounted.lastToolCall();
    mounted.respond(call.id, response);
    await flush();
    expect(button.dataset.status).toBe(expectedStatus);
  });
});

function runtime(
  root: string,
  invoke: (
    operation: string,
    input: Record<string, unknown>,
    context: InvocationContext,
  ) => Promise<unknown>,
  storeOptions: Omit<DeclarativeUiStoreOptions, 'storageRoot'> = {},
) {
  const store = new DeclarativeUiStore({ storageRoot: root, ...storeOptions });
  const resources = new DeclarativeUiMcpAppsResourceAdapter(store);
  return {
    store,
    resources,
    provider: new DeclarativeUiProvider({
      store,
      resources,
      operationInvoker: { invoke },
      allowedOperations: [
        'memory.write',
        'memory.write.v1',
        'memory.write.v2',
        'denied',
        'cancelled',
        'approval_required',
        'nested-failed',
        'mcp-error',
      ],
    }),
  };
}

function actionDocument(
  text: string,
  operation: string,
  revision: number,
  confirmation: boolean,
): DeclarativeUiDocument {
  return {
    protocolVersion: '1.0.0',
    title: text,
    root: {
      type: 'stack',
      id: 'root',
      children: [
        { type: 'text', id: 'label', text },
        { type: 'input', id: 'value', name: 'value', label: 'Value' },
        { type: 'button', id: 'save-button', label: 'Save', actionId: 'save' },
      ],
    },
    actions: [
      {
        id: 'save',
        operation,
        input: { revision },
        eventMap: { value: 'value' },
        ...(confirmation
          ? { confirmation: { title: 'Save', message: 'Persist the change?' } }
          : {}),
      },
    ],
  };
}

function runtimeResponse(
  status: RuntimeExecutionStatus,
  output?: unknown,
  extra: {
    error?: { code: string; message: string };
    approval?: { decision: 'approval'; reason: string };
  } = {},
): RuntimeExecResponse {
  const now = new Date().toISOString();
  return {
    protocolVersion: '1.0.0',
    status,
    ...(output !== undefined ? { result: { output } } : {}),
    ...extra,
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: `receipt-${Math.random()}`,
      executionId: `execution-${Math.random()}`,
      target: 'test.operation',
      principalId: invocationContext.principal.id,
      scope: invocationContext.scope,
      lineage: { rootExecutionId: 'root', depth: 0 },
      status,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  };
}

function outputArtifact(value: unknown): UiArtifact {
  return (value as { output: { artifact: UiArtifact } }).output.artifact;
}

function rendererArtifact(document: DeclarativeUiDocument): UiArtifact {
  return {
    id: 'artifact-1',
    scopeKey: 'scope',
    revision: 7,
    documentDigest: 'd'.repeat(64),
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    document,
    resourceUri: `ui://marshal-declarative/artifact-1/d/${'d'.repeat(64)}/r/7`,
  };
}

interface BrowserMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

function mountTemplate() {
  const host = new Window();
  windows.push(host);
  const frame = host.document.createElement('iframe');
  host.document.body.append(frame);
  const outer = frame.contentWindow!;
  const html = mcpAppsTemplateContent().text;
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  if (!script) throw new Error('Declarative renderer script missing');
  outer.document.write(html.replace(/<script>[\s\S]+<\/script>/, ''));
  const posted: BrowserMessage[] = [];
  Object.defineProperty(host, 'postMessage', {
    configurable: true,
    value: (message: BrowserMessage) => posted.push(message),
  });
  outer.eval(script);
  const send = (data: BrowserMessage) => {
    outer.dispatchEvent(
      new outer.MessageEvent('message', { data, source: host as never }),
    );
  };
  return {
    outer,
    messages: () => posted,
    initialize() {
      const request = posted.find((message) => message.method === 'ui/initialize');
      if (request?.id === undefined) throw new Error('Initialization request missing');
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2026-01-26',
          hostCapabilities: {},
          hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] },
        },
      });
    },
    show(artifact: UiArtifact) {
      send({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent: { artifact } },
      });
    },
    lastToolCall() {
      const call = [...posted].reverse().find((message) => message.method === 'tools/call');
      if (!call || call.id === undefined) throw new Error('Tool call missing');
      return call;
    },
    respond(id: number, result: unknown) {
      send({ jsonrpc: '2.0', id, result });
    },
  };
}

function actionInput(message: BrowserMessage): Record<string, unknown> {
  const params = message.params as {
    arguments: { input: Record<string, unknown> };
  };
  return params.arguments.input;
}

function actionCallResult(output: Record<string, unknown>): Record<string, unknown> {
  return {
    structuredContent: {
      protocolVersion: '1.0.0',
      status: 'success',
      result: { output },
      receipt: { status: 'success' },
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-declarative-ui-'));
  roots.push(root);
  return root;
}
