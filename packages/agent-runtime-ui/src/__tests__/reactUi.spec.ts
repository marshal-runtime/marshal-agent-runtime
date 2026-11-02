import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createReactUiCapabilities } from '../factory.js';
import { ReactUiCompiler } from '../compiler.js';
import { digest, legacySessionScopeKey, ReactUiStore, scopeKey } from '../store.js';
import {
  buildReactUiChromeModel,
  HISTORICAL_REACT_UI_TEMPLATE_URIS,
  REACT_UI_TEMPLATE_URI,
  reactUiTemplateContent,
  resolveReactUiChromeDisplayMode,
} from '../runtimeRenderer.js';
import { validateUiApplicationManifest } from '../applicationManifest.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('portable React UI capabilities', () => {
  it('publishes existing renders as runtime catalog UI applications', async () => {
    const workspacePath = await workspace({
      'Catalog.tsx': 'export default function Catalog(){ return <main>Catalog UI</main> }',
    });
    const current = context('catalog');
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });
    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'Catalog.tsx', title: 'Catalog UI' },
      current,
    );
    const componentId = String(
      ((compiled.output as Record<string, unknown>).component as Record<string, unknown>).id,
    );
    const rendered = await bundle.provider.invoke(
      'ui.render',
      {
        componentId,
        props: {},
        fallback: { summary: 'Catalog fallback' },
      },
      current,
    );
    const renderId = String(
      ((rendered.output as Record<string, unknown>).render as Record<string, unknown>).id,
    );

    await expect(bundle.catalog.list(current)).resolves.toEqual([
      expect.objectContaining({
        id: `ui://marshal-react/render/${renderId}`,
        kind: 'ui_application',
        title: 'Catalog UI',
        action: expect.objectContaining({ type: 'ui_render', renderId }),
      }),
    ]);
  });

  it('publishes the complete adaptive-application manifest schema', async () => {
    const root = await workspace({});
    const bundle = createReactUiCapabilities({ workspacePath: root, stateRoot: join(root, '.state') });
    const input = bundle.provider.get('ui.render')?.inputSchema as {
      properties: { application: Record<string, unknown> };
    };

    expect(input.properties.application).toMatchObject({
      required: ['version', 'presentationModes', 'actions', 'tools'],
      additionalProperties: false,
      properties: {
        version: { const: '1.0.0' },
        presentationModes: { items: { enum: ['inline', 'fullscreen', 'pip'] } },
        actions: { type: 'array' },
        tools: { type: 'array' },
        localState: { required: ['scope', 'schemaVersion'] },
        authoritativeState: { required: ['capability', 'resourceId', 'version'] },
        authoringProfile: { required: ['id', 'version'] },
      },
    });
    expect(bundle.provider.get('ui.compile')?.annotations).toMatchObject({
      mcpApps: {
        authoringContract: {
          version: '1.0.0',
          injectedProp: 'marshal',
          methods: {
            callAction: expect.stringContaining('marshal.callAction'),
            bindActionControl: expect.stringContaining('marshal.bindActionControl'),
            requestDisplayMode: expect.stringContaining('marshal.requestDisplayMode'),
          },
          guidance: expect.stringMatching(/renderer supplies visible named controls.*bind distinct runtime-backed Save and Reopen\/Load/s),
        },
      },
    });
  });

  it('compiles the public typed authoring surface for actions and display modes', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `import { useEffect } from 'react';
import type { MarshalUiComponentProps, UiDisplayMode } from '@marshal/agent-runtime-ui';
type Props = MarshalUiComponentProps<{ initialMode?: UiDisplayMode }>;
export default function Workspace({ marshal, initialMode = 'inline' }: Props) {
  const save = () => marshal.callAction('save-workspace', { name: 'Launch' }, { scope: 'project', idempotencyKey: 'save-v1' });
  const expand = () => marshal.requestDisplayMode('fullscreen');
  useEffect(() => marshal.bindActionControl('save-workspace', save), [marshal]);
  return <main data-mode={initialMode}><button onClick={save}>Save</button><button onClick={expand}>Expand</button></main>;
}`,
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });
    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'ui/Workspace.tsx', title: 'Typed workspace' },
      context('typed-authoring'),
    );
    const component = output(compiled).component as Record<string, unknown>;
    const resource = await bundle.resources.readResource(
      String(component.resourceUri),
      context('typed-authoring'),
    );
    expect(resource.text).toContain('save-workspace');
    expect(resource.text).toContain('requestDisplayMode');
  });

  it('compiles a workspace TSX file into an immutable MCP App and renders with fallback', async () => {
    const workspacePath = await workspace({
      'ui/Counter.tsx': `export default function Counter(props: {count?: number}) {
        return <section><h2>Count</h2><output>{props.count ?? 0}</output></section>;
      }`,
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });

    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'ui/Counter.tsx', title: 'Counter' },
      context('session-a'),
    );
    const component = output(compiled).component as Record<string, unknown>;
    expect(component.id).toMatch(/^[a-f0-9]{64}$/);
    expect(component.resourceUri).toBe(`ui://marshal-react/${component.id}/index.html`);
    expect(component).not.toHaveProperty('html');

    const resources = await bundle.resources.listResources(context('session-a'));
    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe(REACT_UI_TEMPLATE_URI);
    const resource = await bundle.resources.readResource(
      String(component.resourceUri),
      context('session-a'),
    );
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.text).toContain("default-src 'none'");
    expect(resource.text).toContain("connect-src 'none'");
    expect(resource.text).toMatch(/script-src 'sha256-[^']+'/);
    expect(resource.text).toContain("style-src 'unsafe-inline'");
    expect(resource.text).toContain('name="marshal-runtime"');
    expect(resource.text).toContain('marshal:ready');
    expect(resource.text).toContain('marshal_invoke_react_action');
    expect(resource.text).not.toContain("script-src 'unsafe-inline'");
    expect(resource._meta.ui.csp.connectDomains).toEqual([]);
    const bridge = bundle.resources.templateContent();
    expect(bridge.text).toContain('sandbox\',\'allow-scripts');
    expect(bridge.text).not.toContain('allow-same-origin');
    expect(bridge.text).toContain("script-src &#39;unsafe-inline&#39;");
    expect(bridge.text).not.toContain('unsafe-eval');
    expect(bridge.text).toContain("frame-src &#39;self&#39; blob: data:");
    expect(bridge.text).toContain('toolResponseMetadata');
    expect(bridge.text).toContain('mcp_tool_result');
    expect(bridge.text).toContain('const id=renderId(data.params,0);if(id){requestPayload(data.params);return;}');
    expect(bridge.text).toContain("object(current.render)");
    expect(bridge.text).toContain('function allowAuthoredStyles(html)');
    expect(bridge.text).toContain('name="marshal-runtime" content=""');
    expect(bridge.text).toContain('structured.application');
    expect(bridge.text).toContain("['uploadFile','selectFiles','getFileDownloadUrl','requestModal','requestClose','openExternal','setOpenInAppUrl']");
    expect(bridge.text).toContain("data.method==='marshal/extensions/call'");
    expect(bridge.text).toContain('const marker="style-src \'sha256-"');
    expect(bridge.text).toContain('aria-label="Application controls"');
    expect(bridge.text).toContain('button.dataset.chromeKind=kind');
    expect(bridge.text).toContain('min-height:40px');
    expect(bridge.text).toContain('marshal/ui/chrome-action-request');
    expect(bridge.text).toContain('ui/request-display-mode');
    expect(bridge.text).not.toMatch(/@media[^}]*#chrome/s);
    const rendererScript = bridge.text.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(rendererScript).toBeTruthy();
    expect(() => new Function(rendererScript!)).not.toThrow();

    const rendered = await bundle.provider.invoke(
      'ui.render',
      {
        componentId: component.id,
        props: { count: 42 },
        fallback: { summary: 'Counter value: 42', details: { count: 42 } },
      },
      context('session-a'),
    );
    const render = output(rendered).render as Record<string, unknown>;
    expect(output(rendered).mcpApp).toEqual(
      expect.objectContaining({
        resourceUri: REACT_UI_TEMPLATE_URI,
        renderTool: 'runtime_render_component',
        arguments: { renderId: render.id },
      }),
    );
    const tools = await bundle.resources.listRenderTools(context('session-a'));
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'marshal_get_react_payload',
        _meta: expect.objectContaining({
          ui: { visibility: ['app'] },
          'openai/widgetAccessible': true,
          'openai/visibility': 'private',
        }),
      }),
      expect.objectContaining({
        name: 'marshal_update_react_state',
        _meta: expect.objectContaining({ ui: { visibility: ['app'] } }),
      }),
      expect.objectContaining({
        name: render.toolName,
        _meta: expect.objectContaining({
          ui: expect.objectContaining({ resourceUri: REACT_UI_TEMPLATE_URI }),
        }),
      }),
    ]);
    expect(String(tools[2]?.name)).toMatch(/^marshal_render_react_[a-f0-9]{64}$/);
    expect(String(tools[2]?.name)).not.toMatch(/^runtime_/);
    for (const toolName of ['marshal_get_react_payload', 'marshal_update_react_state']) {
      expect(tools.find((tool) => tool.name === toolName)?.outputSchema).toMatchObject({
        type: 'object',
        oneOf: [
          expect.objectContaining({ type: 'object' }),
          {
            type: 'object',
            properties: {
              error: { type: 'string' },
              code: { type: 'string' },
            },
            required: ['error', 'code'],
            additionalProperties: false,
          },
        ],
      });
    }
    const toolResult = await bundle.resources.invokeRenderTool(
      'runtime_render_component',
      { renderId: render.id },
      context('session-a'),
    );
    expect(toolResult?.content[0]?.text).toBe('Counter value: 42');
    expect(toolResult?.structuredContent.props).toEqual({ count: 42 });
    expect(toolResult?.structuredContent.fallback).toEqual({
      summary: 'Counter value: 42',
      details: { count: 42 },
    });
    expect(toolResult?._meta).toEqual(
      expect.objectContaining({
        marshal: expect.objectContaining({
          kind: 'compiled_react_ui',
          componentId: component.id,
          componentHtml: expect.stringContaining('<main id="root"'),
        }),
      }),
    );
    const payloadResult = await bundle.resources.invokeRenderTool(
      'marshal_get_react_payload',
      { renderId: render.id },
      context('session-a'),
    );
    expect(payloadResult?.structuredContent.marshal).toEqual(
      expect.objectContaining({
        kind: 'compiled_react_ui',
        componentId: component.id,
        componentHtml: expect.stringContaining('<main id="root"'),
        storage: {},
      }),
    );
    expect(
      String(
        (payloadResult?.structuredContent.marshal as Record<string, unknown>).componentHtml,
      ),
    ).toContain('Connecting interface');
    expect(payloadResult?._meta).toBeUndefined();
    await bundle.resources.invokeRenderTool(
      'marshal_update_react_state',
      {
        renderId: render.id,
        operation: 'set',
        key: 'counter',
        value: '42',
      },
      context('session-a'),
    );
    const persistedPayload = await bundle.resources.invokeRenderTool(
      'marshal_get_react_payload',
      { renderId: render.id },
      context('session-a'),
    );
    expect(
      (persistedPayload?.structuredContent.marshal as Record<string, unknown>).storage,
    ).toEqual({ counter: '42' });
  });

  it('serves explicitly retained historical renderer resources for old chat messages', async () => {
    const workspacePath = await workspace({});
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });
    const historicalUri = 'ui://marshal-react/runtime-renderer/1.2.0/index.html';

    expect(HISTORICAL_REACT_UI_TEMPLATE_URIS).toContain(historicalUri);
    await expect(bundle.resources.readResource(historicalUri, context('historical-renderer'))).resolves.toMatchObject({
      uri: historicalUri,
      mimeType: 'text/html;profile=mcp-app',
      text: expect.stringContaining('Compiled React interface'),
      _meta: { ui: { resourceUri: historicalUri } },
    });
    await expect(
      bundle.resources.readResource(
        'ui://marshal-react/runtime-renderer/0.0.0/index.html',
        context('historical-renderer'),
      ),
    ).rejects.toThrow('Invalid React UI resource URI');
  });

  it('derives width-independent named chrome from manifest and host capabilities', () => {
    const manifest = {
      version: '1.0.0' as const,
      presentationModes: ['inline', 'fullscreen', 'pip'] as const,
      actions: [
        {
          id: 'save-workspace', version: '1.0.0', title: 'Save workspace',
          target: { kind: 'capability' as const, capability: 'workspace.save' },
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
          allowedScopes: ['project'] as const, requiredPermissions: [], risk: 'write' as const,
          idempotency: 'required' as const,
        },
        {
          id: 'load-workspace', version: '1.0.0',
          target: { kind: 'capability' as const, capability: 'workspace.load' },
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
          allowedScopes: ['project'] as const, requiredPermissions: [], risk: 'read' as const,
          idempotency: 'none' as const,
        },
      ],
      tools: [],
      localState: { scope: 'project' as const, schemaVersion: '1.0.0' },
    };
    const model = buildReactUiChromeModel(manifest, {
      displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'],
    });
    expect(model).toEqual({
      modes: [
        { mode: 'fullscreen', label: 'Fullscreen', available: true },
        { mode: 'pip', label: 'Picture in picture', available: false },
      ],
      actions: [
        { id: 'save-workspace', label: 'Save workspace' },
        { id: 'load-workspace', label: 'Load Workspace' },
      ],
    });
    // Authored markup and viewport width are intentionally absent: outer
    // manifest chrome cannot be hidden by icon-only TSX or container CSS.
    expect(buildReactUiChromeModel(manifest, {
      displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { width: 320 },
    }).modes).toEqual([
      { mode: 'fullscreen', label: 'Fullscreen', available: false },
      { mode: 'pip', label: 'Picture in picture', available: false },
    ]);
  });

  it('offers only display-mode TRANSITIONS — the current mode never renders a no-op control', () => {
    const manifest = {
      presentationModes: ['inline', 'fullscreen', 'pip'] as const,
      actions: [],
      tools: [],
    };
    // Inside fullscreen: the Fullscreen button disappears; pip remains offered.
    expect(buildReactUiChromeModel(manifest, {
      displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    }).modes).toEqual([{ mode: 'pip', label: 'Picture in picture', available: true }]);
    // Inside pip: only the fullscreen transition remains.
    expect(buildReactUiChromeModel(manifest, {
      displayMode: 'pip', availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    }).modes).toEqual([{ mode: 'fullscreen', label: 'Fullscreen', available: true }]);
    // Fullscreen-only app while fullscreen: no mode controls at all.
    expect(buildReactUiChromeModel({ ...manifest, presentationModes: ['inline', 'fullscreen'] as const }, {
      displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'],
    }).modes).toEqual([]);
    // Context without a displayMode (legacy hosts) filters nothing.
    expect(buildReactUiChromeModel(manifest, { availableDisplayModes: ['inline', 'fullscreen'] }).modes).toHaveLength(2);
  });

  it('template chrome has no idle status, hides the empty status row, and keeps error surfaces', () => {
    const template = reactUiTemplateContent().text;
    // The giant idle "Ready." row is gone for good…
    expect(template).not.toContain("'Ready.'");
    // …the status element collapses whenever there is no message…
    expect(template).toContain('chromeStatus.hidden=!chromeMessage');
    // …chrome stays visible for a real message even when every control is filtered out…
    expect(template).toContain('model.modes.length===0&&model.actions.length===0&&!chromeMessage');
    // …and the real error/action statuses survive the cleanup.
    for (const preserved of ["'compile_failed: '", "'refresh_failed: '", "'unsupported: '", "'requesting: '"]) {
      expect(template).toContain(preserved);
    }
    // The serialized chrome model builder carries the current-mode transition filter.
    expect(template).toContain('mode !== current');
  });

  it('template forwards Escape from its own document as an inline display-mode request', () => {
    const template = reactUiTemplateContent().text;
    expect(template).toContain("event.key!=='Escape'");
    expect(template).toContain("'marshal-react-escape-'");
    expect(template).toMatch(/escapeRequests.+ui\/request-display-mode/s);
    // The Escape request only fires while fullscreen — inline documents never emit it.
    expect(template).toContain("!isFullscreen())return");
  });

  it('accepts and round-trips the optional wantsImages declaration, rejecting non-booleans', () => {
    const base = { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] };
    expect(validateUiApplicationManifest(base)).not.toHaveProperty('wantsImages');
    expect(validateUiApplicationManifest({ ...base, wantsImages: true }).wantsImages).toBe(true);
    expect(validateUiApplicationManifest({ ...base, wantsImages: false }).wantsImages).toBe(false);
    expect(() => validateUiApplicationManifest({ ...base, wantsImages: 'yes' })).toThrow(
      'application.wantsImages must be a boolean',
    );
  });

  it('keeps denied and fallback display-mode outcomes typed and honest', () => {
    expect(resolveReactUiChromeDisplayMode('fullscreen', 'inline', { mode: 'fullscreen' })).toEqual({
      requested: 'fullscreen', actual: 'fullscreen', status: 'granted', message: 'granted: opened Fullscreen.',
    });
    expect(resolveReactUiChromeDisplayMode('pip', 'inline', { mode: 'inline' })).toEqual({
      requested: 'pip', actual: 'inline', status: 'fallback', message: 'fallback: host kept inline.',
    });
    expect(resolveReactUiChromeDisplayMode('pip', 'inline', undefined, 'Host policy denied PiP')).toEqual({
      requested: 'pip', actual: 'inline', status: 'denied', message: 'denied: Host policy denied PiP; kept inline.',
    });
    expect(resolveReactUiChromeDisplayMode('fullscreen', 'inline', {})).toMatchObject({
      actual: 'inline', status: 'fallback',
    });
    expect(resolveReactUiChromeDisplayMode('fullscreen', 'inline', undefined, undefined, true)).toEqual({
      requested: 'fullscreen', actual: 'inline', status: 'timed_out',
      message: 'timed_out: Fullscreen request timed out; kept inline.',
    });
  });

  it('is content-addressed and returns the same component for unchanged source', async () => {
    const workspacePath = await workspace({
      'App.tsx': 'export default function App(){ return <p>Stable</p> }',
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });
    const first = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Stable' },
      context('session-a'),
    );
    const second = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Stable' },
      context('session-a'),
    );
    expect((output(first).component as Record<string, unknown>).id).toBe(
      (output(second).component as Record<string, unknown>).id,
    );
    expect(await bundle.store.listComponents(context('session-a'))).toHaveLength(1);
  });

  it('keeps compiled UI durable across sessions while preserving project isolation', async () => {
    const workspacePath = await workspace({
      'App.tsx': 'export default function App(){ return <p>Scoped</p> }',
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });
    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Scoped' },
      context('session-a'),
    );
    const componentId = (output(compiled).component as Record<string, unknown>).id;
    await bundle.provider.invoke(
      'ui.render',
      { componentId, props: {}, fallback: { summary: 'Scoped fallback' } },
      context('session-a'),
    );

    expect(await bundle.resources.listResources(context('session-b'))).toHaveLength(2);
    expect(await bundle.resources.listRenderTools(context('session-b'))).toHaveLength(3);
    await expect(
      bundle.store.getComponent(String(componentId), context('session-b')),
    ).resolves.toEqual(expect.objectContaining({ id: componentId }));

    expect(await bundle.resources.listResources(context('other-session', 'other-project'))).toEqual([
      expect.objectContaining({ uri: REACT_UI_TEMPLATE_URI }),
    ]);
    await expect(
      bundle.store.getComponent(String(componentId), context('other-session', 'other-project')),
    ).rejects.toThrow('not found in this scope');
  });

  it('recovers pre-upgrade session-scoped renders and localStorage after a restart', async () => {
    const workspacePath = await workspace({
      'Legacy.tsx': 'export default function Legacy(){ return <p>Legacy</p> }',
    });
    const stateRoot = join(workspacePath, '.state');
    const firstContext = context('legacy-session');
    const first = createReactUiCapabilities({ workspacePath, stateRoot });
    const compiled = await first.provider.invoke(
      'ui.compile',
      { entryPath: 'Legacy.tsx', title: 'Legacy component' },
      firstContext,
    );
    const componentId = String((output(compiled).component as Record<string, unknown>).id);
    const rendered = await first.provider.invoke(
      'ui.render',
      { componentId, props: { mode: 'legacy' }, fallback: { summary: 'Legacy fallback' } },
      firstContext,
    );
    const renderId = String((output(rendered).render as Record<string, unknown>).id);
    await first.resources.invokeRenderTool(
      'marshal_update_react_state',
      { renderId, operation: 'set', key: 'selection', value: 'Two' },
      firstContext,
    );

    const storageRoot = join(stateRoot, 'react-ui');
    const currentDirectory = join(storageRoot, 'scopes', scopeKey(firstContext));
    const legacyKey = legacySessionScopeKey(firstContext);
    const legacyDirectory = join(storageRoot, 'scopes', legacyKey);
    await rename(currentDirectory, legacyDirectory);
    for (const target of [
      join(legacyDirectory, 'components', `${componentId}.json`),
      join(legacyDirectory, 'renders', `${renderId}.json`),
      join(legacyDirectory, 'state', `${renderId}.json`),
    ]) {
      const record = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
      await writeFile(target, `${JSON.stringify({ ...record, scopeKey: legacyKey }, null, 2)}\n`, 'utf8');
    }

    const restarted = createReactUiCapabilities({
      workspacePath,
      stateRoot,
      storeLimits: { recoverLegacySessionScopes: true },
    });
    const payload = await restarted.resources.invokeRenderTool(
      'marshal_get_react_payload',
      { renderId },
      context('session-after-restart'),
    );
    expect(payload?.structuredContent).toMatchObject({
      props: { mode: 'legacy' },
      render: { id: renderId, componentId },
      marshal: { storage: { selection: 'Two' } },
    });
    await expect(
      restarted.store.getRender(renderId, context('another-session')),
    ).resolves.toEqual(expect.objectContaining({ id: renderId }));
  });

  it('rejects traversal, Node built-ins, and non-allow-listed packages', async () => {
    const workspacePath = await workspace({
      'Node.tsx': `import fs from 'node:fs'; export default function App(){ return <p>{String(fs)}</p> }`,
      'Package.tsx': `import yaml from 'yaml'; export default function App(){ return <p>{String(yaml)}</p> }`,
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
    });

    await expect(
      bundle.provider.invoke(
        'ui.compile',
        { entryPath: '../outside.tsx', title: 'Outside' },
        context('session-a'),
      ),
    ).rejects.toThrow('outside the workspace');
    await expect(
      bundle.provider.invoke(
        'ui.compile',
        { entryPath: 'Node.tsx', title: 'Node' },
        context('session-a'),
      ),
    ).rejects.toThrow('Node built-in import is unavailable');
    await expect(
      bundle.provider.invoke(
        'ui.compile',
        { entryPath: 'Package.tsx', title: 'Package' },
        context('session-a'),
      ),
    ).rejects.toThrow('Package import yaml is not allow-listed');
  });

  it('verifies registered component audit digests and uses a lower-risk permission', async () => {
    const source = `import {label} from './AuditedHelper'; export default function App(){ return <p>{label}</p> }`;
    const helper = `export const label = 'Audited';`;
    const workspacePath = await workspace({ 'Audited.tsx': source, 'AuditedHelper.ts': helper });
    const audit = await new ReactUiCompiler({ workspacePath }).snapshotRegisteredGraph({
      entryPath: 'Audited.tsx',
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      registeredComponents: [
        {
          id: 'audited-card',
          version: '1.0.0',
          title: 'Audited card',
          entryPath: 'Audited.tsx',
          audit: {
            reviewedBy: 'security@example.test',
            reviewedAt: '2026-07-31T00:00:00.000Z',
            ...audit,
          },
        },
      ],
    });

    const descriptor = bundle.provider.get('ui.registered.compile');
    expect(descriptor?.permissions?.[0]).toEqual(
      expect.objectContaining({ permission: 'ui.registered_component.use', risk: 'low' }),
    );
    expect(bundle.provider.get('ui.compile')?.permissions?.[0]).toEqual(
      expect.objectContaining({ permission: 'trusted_ui', risk: 'high' }),
    );
    const result = await bundle.provider.invoke(
      'ui.registered.compile',
      { componentId: 'audited-card' },
      context('session-a'),
    );
    expect((output(result).component as Record<string, unknown>).registeredComponent).toEqual({
      id: 'audited-card',
      version: '1.0.0',
      reviewedBy: 'security@example.test',
      graphDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const changedHelper = `export const label = 'Changed';`;
    await writeFile(join(workspacePath, 'AuditedHelper.ts'), changedHelper, 'utf8');
    const callerOwnedHelperAudit = audit.graph.inputs.find(
      (input) => input.kind === 'workspace' && input.path === 'AuditedHelper.ts',
    );
    expect(callerOwnedHelperAudit).toBeDefined();
    (callerOwnedHelperAudit as { digest: string }).digest = digest(changedHelper);
    await expect(
      bundle.provider.invoke(
        'ui.registered.compile',
        { componentId: 'audited-card' },
        context('session-a'),
      ),
    ).rejects.toThrow('no longer matches its audited build graph');

    await writeFile(join(workspacePath, 'AuditedHelper.ts'), helper, 'utf8');
    await writeFile(join(workspacePath, 'Audited.tsx'), `${source}\n// changed`, 'utf8');
    await expect(
      bundle.provider.invoke(
        'ui.registered.compile',
        { componentId: 'audited-card' },
        context('session-a'),
      ),
    ).rejects.toThrow('no longer matches its audited source digest');
  });

  it('rejects registered package source or identity changes with an unchanged entry', async () => {
    const workspacePath = await workspace({
      'PackageCard.tsx': `import {label} from 'audited-package'; export default function App(){ return <p>{label}</p> }`,
      'vendor/audited-package/package.json': JSON.stringify({ name: 'audited-package', version: '1.0.0' }),
      'vendor/audited-package/index.js': `export const label = 'package-old';`,
    });
    const packageRoot = join(workspacePath, 'vendor', 'audited-package');
    const packageEntry = join(packageRoot, 'index.js');
    const packageResolver = (specifier: string) => specifier === 'audited-package' ? packageEntry : undefined;
    const compilerOptions = {
      workspacePath,
      allowedPackages: ['audited-package'],
      packageImportResolver: packageResolver,
      trustedPackageRoots: [packageRoot],
    };
    const audit = await new ReactUiCompiler(compilerOptions).snapshotRegisteredGraph({
      entryPath: 'PackageCard.tsx',
      allowedPackages: ['audited-package'],
    });
    expect(audit.graph.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'package',
        path: 'index.js',
        digest: digest(`export const label = 'package-old';`),
        package: expect.objectContaining({ name: 'audited-package', version: '1.0.0' }),
      }),
    ]));
    const registeredComponents = [{
      id: 'package-card', version: '1.0.0', title: 'Package card', entryPath: 'PackageCard.tsx',
      allowedPackages: ['audited-package'],
      audit: { reviewedBy: 'security@example.test', reviewedAt: '2026-07-31T00:00:00.000Z', ...audit },
    }];
    const bundle = createReactUiCapabilities({
      ...compilerOptions,
      stateRoot: join(workspacePath, '.state'),
      registeredComponents,
    });

    await writeFile(packageEntry, `export const label = 'package-new';`, 'utf8');
    await expect(bundle.provider.invoke(
      'ui.registered.compile', { componentId: 'package-card' }, context('session-a'),
    )).rejects.toThrow('no longer matches its audited build graph');

    await writeFile(packageEntry, `export const label = 'package-old';`, 'utf8');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'audited-package', version: '2.0.0' }),
      'utf8',
    );
    await expect(bundle.provider.invoke(
      'ui.registered.compile', { componentId: 'package-card' }, context('session-a'),
    )).rejects.toThrow('no longer matches its audited build graph');
  });

  it('bundles the exact audited snapshot when a loaded helper changes during resolution', async () => {
    const oldHelper = `import {suffix} from 'snapshot-package'; export const label = 'snapshot-old-' + suffix;`;
    const newHelper = `import {suffix} from 'snapshot-package'; export const label = 'snapshot-new-' + suffix;`;
    const workspacePath = await workspace({
      'SnapshotCard.tsx': `import {label} from './SnapshotHelper'; export default function App(){ return <p>{label}</p> }`,
      'SnapshotHelper.ts': oldHelper,
      'vendor/snapshot-package/package.json': JSON.stringify({ name: 'snapshot-package', version: '1.0.0' }),
      'vendor/snapshot-package/index.js': `export const suffix = 'package';`,
    });
    const helperPath = join(workspacePath, 'SnapshotHelper.ts');
    const packageRoot = join(workspacePath, 'vendor', 'snapshot-package');
    const packageEntry = join(packageRoot, 'index.js');
    const baseOptions = {
      workspacePath,
      allowedPackages: ['snapshot-package'],
      trustedPackageRoots: [packageRoot],
    };
    const audit = await new ReactUiCompiler({
      ...baseOptions,
      packageImportResolver: (specifier) => specifier === 'snapshot-package' ? packageEntry : undefined,
    }).snapshotRegisteredGraph({
      entryPath: 'SnapshotCard.tsx',
      allowedPackages: ['snapshot-package'],
    });
    let mutated = false;
    const bundle = createReactUiCapabilities({
      ...baseOptions,
      stateRoot: join(workspacePath, '.state'),
      packageImportResolver: (specifier) => {
        if (specifier !== 'snapshot-package') return undefined;
        writeFileSync(helperPath, newHelper, 'utf8');
        mutated = true;
        return packageEntry;
      },
      registeredComponents: [{
        id: 'snapshot-card', version: '1.0.0', title: 'Snapshot card', entryPath: 'SnapshotCard.tsx',
        allowedPackages: ['snapshot-package'],
        audit: { reviewedBy: 'security@example.test', reviewedAt: '2026-07-31T00:00:00.000Z', ...audit },
      }],
    });

    const result = await bundle.provider.invoke(
      'ui.registered.compile', { componentId: 'snapshot-card' }, context('session-a'),
    );
    expect(mutated).toBe(true);
    const componentId = String((output(result).component as Record<string, unknown>).id);
    const stored = await bundle.store.getComponent(componentId, context('session-a'));
    expect(stored.html).toContain('snapshot-old-');
    expect(stored.html).not.toContain('snapshot-new-');
    expect(await readFile(helperPath, 'utf8')).toBe(newHelper);
  });

  it('rejects planted directory symlinks before reading or writing scoped records', async () => {
    const root = await workspace({});
    const storageRoot = join(root, 'react-ui-store');
    const outside = join(root, 'outside');
    const currentContext = context('symlink-session');
    await mkdir(join(storageRoot, 'scopes'), { recursive: true });
    await mkdir(outside);
    const linkedScope = join(storageRoot, 'scopes', scopeKey(currentContext));
    if (!(await createDirectoryLink(outside, linkedScope))) return;

    const store = new ReactUiStore({ storageRoot });
    await expect(store.listComponents(currentContext)).rejects.toThrow('Symbolic links');
    await expect(
      store.putComponent(
        {
          id: 'a'.repeat(64),
          title: 'Unsafe',
          sourceKind: 'workspace_file',
          sourcePath: 'Unsafe.tsx',
          sourceDigest: 'b'.repeat(64),
          bundleDigest: 'c'.repeat(64),
          createdAt: new Date(0).toISOString(),
          resourceUri: `ui://marshal-react/${'a'.repeat(64)}/index.html`,
          html: '<p>unsafe</p>',
          inputs: [],
        },
        currentContext,
      ),
    ).rejects.toThrow('Symbolic links');
  });
});

function context(sessionId: string, projectId = 'project'): InvocationContext {
  return {
    principal: { id: 'agent', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId, sessionId },
  };
}

function output(value: unknown): Record<string, unknown> {
  return (value as { output: Record<string, unknown> }).output;
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-react-ui-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
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
