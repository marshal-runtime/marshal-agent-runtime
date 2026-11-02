import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { createReactUiCapabilities } from '../factory.js';
import { reactUiTemplateContent, REACT_UI_PAYLOAD_TOOL_NAME, REACT_UI_TEMPLATE_URI } from '../runtimeRenderer.js';
import type { UiApplicationManifest, UiProtocolMessage } from '../applicationTypes.js';

/**
 * End-to-end exercise of the agent-authored React example shipped in
 * examples/agent-authored/StatusPanel.tsx: the EXACT loop the runtime prompt
 * guidance documents — write TSX in the workspace, ui.compile, ui.render with
 * an application manifest, discover the render as a catalog ui_application,
 * fetch the payload through the render tool, and mount the compiled HTML in
 * the isolated sandbox renderer. No live host, no profile writes: everything
 * runs against a temp workspace and the portable renderer template.
 */

const exampleSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/agent-authored/StatusPanel.tsx',
);

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(sessionId: string, workspaceName = 'example-workspace'): InvocationContext {
  return {
    principal: { id: 'agent-1', kind: 'agent' },
    scope: { sessionId, workspaceName },
  } as InvocationContext;
}

const application: UiApplicationManifest = {
  version: '1.0.0',
  presentationModes: ['inline', 'fullscreen'],
  actions: [{
    id: 'refresh-triage',
    version: '1.0.0',
    title: 'Refresh triage',
    target: { kind: 'capability', capability: 'triage.items.list' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    allowedScopes: ['session'],
    requiredPermissions: [],
    risk: 'read',
    idempotency: 'supported',
  }],
  tools: [],
  localState: { scope: 'session', schemaVersion: '1.0.0' },
};

async function compileExample() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-authored-example-'));
  temporaryRoots.push(workspacePath);
  await writeFile(join(workspacePath, 'StatusPanel.tsx'), await readFile(exampleSource, 'utf8'));
  const bundle = createReactUiCapabilities({
    workspacePath,
    stateRoot: join(workspacePath, '.state'),
  });
  const current = context('session-example');
  const compiled = await bundle.provider.invoke(
    'ui.compile',
    { entryPath: 'StatusPanel.tsx', title: 'Triage status' },
    current,
  );
  const component = (compiled.output as { component: { id: string; html: string } }).component;
  const rendered = await bundle.provider.invoke(
    'ui.render',
    {
      componentId: component.id,
      props: {
        summary: [
          { severity: 'high', count: 2, ids: ['a-1', 'a-2'] },
          { severity: 'low', count: 1, ids: ['b-1'] },
        ],
        generatedAt: 'run fixture-1',
      },
      fallback: { summary: 'Triage status panel' },
      application,
    },
    current,
  );
  const render = (rendered.output as { render: { id: string; toolName: string } }).render;
  return { bundle, current, component, render };
}

describe('agent-authored React example (real compile → render → payload → mount)', () => {
  it('compiles the shipped example, renders it, and publishes a discoverable ui_application', async () => {
    const { bundle, current, component, render } = await compileExample();

    expect(component.id).toMatch(/^[a-f0-9]{64}$/);
    expect(render.id).toMatch(/^[a-f0-9]{64}$/);
    expect(render.toolName).toBe(`marshal_render_react_${render.id}`);

    const catalog = await bundle.catalog.list(current);
    expect(catalog).toContainEqual(expect.objectContaining({
      id: `ui://marshal-react/render/${render.id}`,
      kind: 'ui_application',
      title: 'Triage status',
      action: { type: 'ui_render', renderId: render.id, resourceUri: REACT_UI_TEMPLATE_URI },
    }));

    // Workspace-file renders are live: the catalog entry advertises live
    // editing (the renderer polls the workspace and recompiles on change).
    const entry = catalog.find((candidate) => candidate.id === `ui://marshal-react/render/${render.id}`);
    expect(entry?.metadata).toMatchObject({ live: true, presentationModes: ['inline', 'fullscreen'] });
  });

  it('serves the compiled payload through the render tool with props and manifest intact', async () => {
    const { bundle, current, component, render } = await compileExample();
    const payload = await bundle.resources.invokeRenderTool(
      REACT_UI_PAYLOAD_TOOL_NAME,
      { renderId: render.id },
      current,
    );
    expect(payload).toBeDefined();
    const structured = payload!.structuredContent as {
      props: { summary: unknown[]; generatedAt: string };
      marshal: { kind: string; componentHtml: string; componentId: string; application?: UiApplicationManifest };
    };
    expect(structured.props.generatedAt).toBe('run fixture-1');
    expect(structured.props.summary).toHaveLength(2);
    expect(structured.marshal.kind).toBe('compiled_react_ui');
    expect(structured.marshal.componentId).toBe(component.id);
    expect(structured.marshal.application?.actions[0]?.id).toBe('refresh-triage');
    // The compiled bundle really contains the example component's code.
    expect(structured.marshal.componentHtml).toContain('status-panel');
    expect(structured.marshal.componentHtml).toContain('Triage status');
  });

  it('projects the authored render as a published application the host open capabilities can resolve', async () => {
    const { bundle, current, render } = await compileExample();
    const published = await bundle.publishedApplications(current);
    const entry = published.find((candidate) => candidate.id === render.id);
    expect(entry).toMatchObject({
      ownerId: 'marshal.react-ui',
      id: render.id,
      revisionId: render.id,
      renderId: render.id,
      title: 'Triage status',
      resource: { uri: REACT_UI_TEMPLATE_URI, mimeType: 'text/html;profile=mcp-app' },
    });
    expect(entry!.application.actions[0]?.id).toBe('refresh-triage');

    // Mirror the host's requireApplication/applicationContent consumption
    // verbatim (electron/marshal-runtime/ui-providers.ts): lookup by
    // ownerId+applicationId, then build the instance content. This is the
    // exact contract ui.application.open / ui.chat.card.show need to place
    // the authored render on a host surface.
    const owner = { extensionId: 'marshal.react-ui', applicationId: render.id };
    const resolved = published.find(
      (candidate) => candidate.ownerId === owner.extensionId && candidate.id === owner.applicationId,
    );
    expect(resolved).toBeDefined();
    const content = {
      kind: 'application' as const,
      renderId: resolved!.renderId,
      resource: {
        uri: resolved!.resource.uri,
        mimeType: resolved!.resource.mimeType ?? 'text/plain',
        name: resolved!.title,
      },
      descriptor: resolved!.application,
    };
    expect(content.resource.mimeType.split(';')[0]).toBe('text/html');
    expect(content.descriptor.presentationModes).toEqual(['inline', 'fullscreen']);
  });

  it('exposes the projection through the public ui.applications.list capability with true scope semantics', async () => {
    const { bundle, current, render } = await compileExample();

    // Public API path the host bridge consumes: the same capability plane as
    // every runtimeInvoke, same invocation scope.
    const listed = await bundle.provider.invoke('ui.applications.list', {}, current);
    const applications = (listed.output as { applications: ReadonlyArray<Record<string, unknown>> })
      .applications;
    expect(applications).toContainEqual(expect.objectContaining({
      ownerId: 'marshal.react-ui',
      id: render.id,
      renderId: render.id,
      resource: expect.objectContaining({ uri: REACT_UI_TEMPLATE_URI }),
    }));

    // TRUE scope semantics — workspace(Id/Path) + project + principal.
    // A different sessionId alone does NOT isolate (renders are not
    // per-session); a different workspaceId, projectId, or principal does.
    const scope = (overrides: Record<string, unknown>, principalId = 'agent-1') => ({
      principal: { id: principalId, kind: 'agent' },
      scope: { sessionId: 'session-example', workspaceName: 'example-workspace', ...overrides },
    }) as InvocationContext;
    const list = async (context: InvocationContext) =>
      ((await bundle.provider.invoke('ui.applications.list', {}, context)).output as {
        applications: readonly unknown[];
      }).applications;

    await expect(list(scope({ sessionId: 'another-session' }))).resolves.toHaveLength(1);
    await expect(list(scope({ workspaceId: 'other-workspace-id' }))).resolves.toHaveLength(0);
    await expect(list(scope({ projectId: 'other-project' }))).resolves.toHaveLength(0);
    await expect(list(scope({}, 'other-principal'))).resolves.toHaveLength(0);
  });

  it('mounts the real compiled HTML inside the sandboxed renderer with declared-action chrome', async () => {
    const { bundle, current, render } = await compileExample();
    const payload = await bundle.resources.invokeRenderTool(
      REACT_UI_PAYLOAD_TOOL_NAME,
      { renderId: render.id },
      current,
    );
    const structured = payload!.structuredContent as Record<string, unknown> & {
      marshal: Record<string, unknown>;
    };

    // Mount the portable renderer template in an isolated DOM.
    const host = new Window({ url: 'https://host.example/' });
    const frame = host.document.createElement('iframe');
    host.document.body.append(frame);
    const outer = frame.contentWindow!;
    Object.defineProperties(outer, {
      setTimeout: { configurable: true, value: setTimeout },
      clearTimeout: { configurable: true, value: clearTimeout },
    });
    const templateHtml = reactUiTemplateContent().text;
    const script = templateHtml.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    outer.document.write(templateHtml.replace(/<script>[\s\S]+<\/script>/, ''));
    const postedToHost: UiProtocolMessage[] = [];
    Object.defineProperty(host, 'postMessage', {
      configurable: true,
      value: (message: UiProtocolMessage) => postedToHost.push(message),
    });
    outer.eval(script!);
    const send = (data: UiProtocolMessage) => {
      outer.dispatchEvent(new outer.MessageEvent('message', { data, source: host as never }));
    };

    // Host initialization handshake, then deliver the REAL payload as the
    // tool result (structuredContent.marshal is where the adapter puts it).
    send({
      jsonrpc: '2.0',
      id: 'marshal-react-renderer-init',
      result: {
        protocolVersion: '2026-01-26',
        hostCapabilities: {},
        hostContext: {
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen'],
          containerDimensions: { width: 320, height: 700 },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: structured },
    });

    // The compiled component is mounted in a sandboxed child iframe whose
    // srcdoc is the REAL compiled HTML with props injected.
    const child = outer.document.querySelector<HTMLIFrameElement>('#mount iframe');
    expect(child).not.toBeNull();
    expect(child!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(child!.srcdoc).toContain('status-panel');
    expect(child!.srcdoc).toContain('marshal-props');

    // The manifest-declared action appears as bounded renderer chrome; it is
    // disabled until the application binds its handler — never a free-form
    // escape from the sandbox.
    const chromeButton = outer.document.querySelector<HTMLButtonElement>(
      'button[data-chrome-key="refresh-triage"]',
    );
    expect(chromeButton).not.toBeNull();
    expect(chromeButton!.textContent).toBe('Refresh triage');
    expect(chromeButton!.disabled).toBe(true);

    // Fullscreen is offered because the manifest declares it; pip is not.
    expect(outer.document.querySelector('button[data-chrome-key="fullscreen"]')).not.toBeNull();
    expect(outer.document.querySelector('button[data-chrome-key="pip"]')).toBeNull();
  });
});
