import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvocationContext, RuntimeExecResponse } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeclarativeUiMcpAppsResourceAdapter } from '../ui/mcpAppsResourceAdapter.js';
import { DeclarativeUiProvider } from '../ui/provider.js';
import { DeclarativeUiStore, scopeKey } from '../ui/store.js';
import { renderMcpAppsHtml } from '../ui/renderer.js';

const roots: string[] = [];
const context = (sessionId: string): InvocationContext => ({
  principal: { id: 'codex-main', kind: 'agent' },
  scope: { workspaceId: 'workspace-1', projectId: 'project-1', sessionId },
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('declarative UI capabilities', () => {
  it('publishes the complete recursive document schema for reliable authoring', () => {
    const provider = new DeclarativeUiProvider({
      store: {} as DeclarativeUiStore,
      resources: {} as DeclarativeUiMcpAppsResourceAdapter,
    });
    type UiDefinitions = { uiNode?: { oneOf?: unknown[] } };
    type DocumentSchema = {
      properties?: { root?: unknown };
      $defs?: UiDefinitions;
    };
    const capability = provider.get('ui.artifacts.create');
    const inputSchema = capability?.inputSchema as {
      properties?: { document?: DocumentSchema };
      $defs?: UiDefinitions;
    };
    const outputSchema = capability?.outputSchema as {
      properties?: {
        artifact?: { properties?: { document?: DocumentSchema } };
      };
      $defs?: UiDefinitions;
    };
    const inputDocument = inputSchema.properties?.document;
    const outputDocument = outputSchema.properties?.artifact?.properties?.document;

    expect(inputDocument?.properties?.root).toEqual({ $ref: '#/$defs/uiNode' });
    expect(outputDocument?.properties?.root).toEqual({ $ref: '#/$defs/uiNode' });
    expect(inputSchema.$defs?.uiNode?.oneOf).toHaveLength(11);
    expect(outputSchema.$defs?.uiNode?.oneOf).toHaveLength(11);
    expect(inputDocument?.$defs?.uiNode?.oneOf).toHaveLength(11);
    expect(JSON.stringify(inputSchema)).toContain('small');
    expect(JSON.stringify(inputSchema)).toContain('columns');
    expect(JSON.stringify(inputSchema)).toContain('actionId');
  });

  it('persists CRUD revisions within a cryptographically derived scope', async () => {
    const root = await temporaryRoot();
    const store = new DeclarativeUiStore({ storageRoot: root });
    const created = await store.create(document('First'), context('session-a'));
    expect(created.revision).toBe(1);
    expect((await store.list(context('session-a')))[0]?.id).toBe(created.id);
    await expect(store.get(created.id, context('session-b'))).rejects.toThrow('not found');

    const updated = await store.update(created.id, document('Second'), context('session-a'), 1);
    expect(updated.revision).toBe(2);
    expect(updated.resourceUri).toMatch(/\/r\/2$/);
    await expect(
      new DeclarativeUiMcpAppsResourceAdapter(store).readResource(
        created.resourceUri,
        context('session-a'),
      ),
    ).resolves.toEqual(expect.objectContaining({ uri: created.resourceUri }));
    await expect(
      store.update(created.id, document('Conflict'), context('session-a'), 1),
    ).rejects.toThrow('revision conflict');
    expect(await store.delete(created.id, context('session-a'))).toBe(true);
    expect(await store.delete(created.id, context('session-a'))).toBe(false);
  });

  it('renders an MCP Apps resource with network denial and escaped authored text', async () => {
    const root = await temporaryRoot();
    const store = new DeclarativeUiStore({ storageRoot: root });
    const artifact = await store.create(
      document('<script>fetch("https://evil.test")</script>'),
      context('session-a'),
    );
    const adapter = new DeclarativeUiMcpAppsResourceAdapter(store);
    const descriptor = adapter.descriptor(artifact);
    const content = await adapter.readResource(artifact.resourceUri, context('session-a'));
    const template = adapter.templateContent();

    expect(descriptor.mimeType).toBe('text/html;profile=mcp-app');
    expect(descriptor._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(content.text).toContain('connect-src &#39;none&#39;');
    expect(content.text).toContain(
      '&lt;script&gt;fetch(&quot;https://evil.test&quot;)&lt;/script&gt;',
    );
    expect(content.text).not.toContain('<script>fetch("https://evil.test")</script>');
    expect(adapter.toolMetadata(artifact).ui.resourceUri).toBe(artifact.resourceUri);
    expect(adapter.toolMetadata().ui.resourceUri).toBe('ui://marshal-declarative/runtime-renderer');
    expect(template.text).toContain('event.source!==parent');
    expect(template.text).toContain('ui/notifications/tool-result');
    expect(template.text).toContain('ui/notifications/tool-cancelled');
    expect(template.text).toContain('did not contain a validated declarative artifact');
    expect(template.text).not.toContain('notifyIntrinsicHeight');
    expect(template.text).not.toContain('Waiting for a validated UI artifact');
    expect((await adapter.listResources(context('session-a')))[0]?.uri).toBe(adapter.templateUri);
  });

  it('bridges only allow-listed actions with validated event mapping and confirmation', async () => {
    const root = await temporaryRoot();
    const store = new DeclarativeUiStore({ storageRoot: root });
    const resources = new DeclarativeUiMcpAppsResourceAdapter(store);
    const invoke = vi.fn(async (_operation: string, input: unknown, _context: InvocationContext) =>
      runtimeResponse({ accepted: input }),
    );
    const provider = new DeclarativeUiProvider({
      store,
      resources,
      operationInvoker: { invoke },
      allowedOperations: ['memory.search'],
    });
    const documentWithAction = {
      ...document('Search'),
      root: {
        type: 'stack',
        id: 'root',
        children: [
          { type: 'input', id: 'query', name: 'query', label: 'Query' },
          { type: 'button', id: 'submit', label: 'Search', actionId: 'search' },
        ],
      },
      actions: [
        {
          id: 'search',
          operation: 'memory.search',
          input: { limit: 5 },
          eventMap: { query: 'query' },
          confirmation: { title: 'Search memory', message: 'Run the search?' },
        },
      ],
    };
    const created = await provider.invoke(
      'ui.artifacts.create',
      { document: documentWithAction },
      context('session-a'),
    );
    const artifact = (
      created.output as {
        artifact: { id: string; revision: number; documentDigest: string };
      }
    ).artifact;
    const actionInput = {
      artifactId: artifact.id,
      revision: artifact.revision,
      documentDigest: artifact.documentDigest,
      actionId: 'search',
      event: { query: 'adapter' },
      idempotencyKey: 'search-adapter',
    };
    const confirmation = await provider.invoke(
      'ui.actions.invoke',
      actionInput,
      context('session-a'),
    );
    expect(confirmation.output).toMatchObject({ status: 'confirmation_required' });
    expect(invoke).not.toHaveBeenCalled();

    const completed = await provider.invoke(
      'ui.actions.invoke',
      { ...actionInput, confirmed: true },
      context('session-a'),
    );
    expect(completed.output).toMatchObject({ status: 'completed', operation: 'memory.search' });
    const baseContext = context('session-a');
    expect(invoke).toHaveBeenCalledWith(
      'memory.search',
      { limit: 5, query: 'adapter' },
      expect.objectContaining({
        principal: baseContext.principal,
        scope: baseContext.scope,
        executionId: expect.any(String),
        lineage: {
          rootExecutionId: expect.any(String),
          depth: 0,
        },
        metadata: expect.objectContaining({
          trustedExecutionBoundary: 'ui_action',
          uiActionReceiptId: expect.any(String),
        }),
      }),
    );
    const invocationContext = invoke.mock.calls[0]?.[2];
    expect(invocationContext?.executionId).toBe(invocationContext?.lineage?.rootExecutionId);
    expect(invocationContext?.lineage?.rootExecutionId).toBe(
      invocationContext?.metadata?.uiActionReceiptId,
    );
  });

  it('rejects unknown node types, recursive actions, oversized documents, and unsafe event keys', async () => {
    const root = await temporaryRoot();
    const store = new DeclarativeUiStore({ storageRoot: root, maxDocumentBytes: 2_000 });
    const resources = new DeclarativeUiMcpAppsResourceAdapter(store);
    const provider = new DeclarativeUiProvider({
      store,
      resources,
      allowedOperations: ['ui.actions.invoke'],
    });
    await expect(
      store.create(
        { ...document('x'), root: { type: 'html', id: 'root', html: '<b>x</b>' } },
        context('a'),
      ),
    ).rejects.toThrow('Unsupported UI node');
    await expect(
      store.create(
        {
          ...document('x'),
          root: { type: 'text', id: 'root', text: 'safe', html: '<b>unsafe</b>' },
        },
        context('a'),
      ),
    ).rejects.toThrow('unsupported field html');
    await expect(store.create(document('x'.repeat(3_000)), context('a'))).rejects.toThrow(
      'exceeds',
    );
    await expect(
      provider.invoke(
        'ui.artifacts.create',
        {
          document: { ...document('x'), actions: [{ id: 'loop', operation: 'ui.actions.invoke' }] },
        },
        context('a'),
      ),
    ).rejects.toThrow('recursively');
  });

  it('rejects planted directory symlinks before list, write, or delete operations', async () => {
    const root = await temporaryRoot();
    const storageRoot = join(root, 'declarative-ui-store');
    const outside = join(root, 'outside');
    const currentContext = context('symlink-session');
    await mkdir(join(storageRoot, 'scopes'), { recursive: true });
    await mkdir(outside);
    const linkedScope = join(storageRoot, 'scopes', scopeKey(currentContext));
    if (!(await createDirectoryLink(outside, linkedScope))) return;

    const store = new DeclarativeUiStore({ storageRoot });
    await expect(store.list(currentContext)).rejects.toThrow('Symbolic links');
    await expect(store.create(document('Unsafe'), currentContext)).rejects.toThrow('Symbolic links');
    await expect(store.delete('artifact-1', currentContext)).rejects.toThrow('Symbolic links');
  });
});

function document(text: string) {
  return {
    protocolVersion: '1.0.0',
    title: 'Test UI',
    root: { type: 'text', id: 'root', text },
  } as const;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-ui-'));
  roots.push(root);
  return root;
}

async function createDirectoryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
}

function runtimeResponse(output: unknown): RuntimeExecResponse {
  const at = new Date().toISOString();
  return {
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output },
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: 'target-receipt',
      executionId: 'target-execution',
      target: 'memory.search',
      principalId: 'codex-main',
      lineage: { rootExecutionId: 'target-execution', depth: 0 },
      status: 'success',
      startedAt: at,
      completedAt: at,
      durationMs: 0,
    },
  };
}
