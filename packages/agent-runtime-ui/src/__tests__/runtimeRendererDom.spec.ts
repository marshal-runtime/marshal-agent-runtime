import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UI_ACTION_TOOL_NAME,
  UI_CHROME_ACTION_BINDING_METHOD,
  UI_CHROME_ACTION_CANCEL_METHOD,
  UI_CHROME_ACTION_REQUEST_METHOD,
  UI_CHROME_ACTION_RESULT_METHOD,
  UI_CHROME_ACTION_TIMEOUT_MS,
  type UiApplicationManifest,
  type UiProtocolMessage,
} from '../applicationTypes.js';
import { reactUiTemplateContent } from '../runtimeRenderer.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('mounted adaptive runtime renderer', () => {
  it('keeps 320px chrome present, reports outer plus child height, and rejects foreign sources', async () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    const chrome = mounted.outer.document.querySelector<HTMLElement>('#chrome')!;
    Object.defineProperty(chrome, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 320, height: 96, top: 0, left: 0, right: 320, bottom: 96, x: 0, y: 0, toJSON() {} }),
    });

    const fullscreen = mounted.button('fullscreen');
    const pip = mounted.button('pip');
    expect(chrome.hidden).toBe(false);
    expect(fullscreen.textContent).toBe('Fullscreen');
    expect(pip.textContent).toBe('Picture in picture');
    expect(mounted.html).toContain('flex-wrap:wrap');
    expect(mounted.html).toContain('min-width:40px;min-height:40px');

    const foreign = new Window();
    mounted.send(foreign, {
      jsonrpc: '2.0', method: UI_CHROME_ACTION_BINDING_METHOD,
      params: { actionId: 'save-workspace', bound: true },
    });
    expect(mounted.button('save-workspace').disabled).toBe(true);
    mounted.bind('save-workspace');
    expect(mounted.button('save-workspace').disabled).toBe(false);

    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 320, height: 420 },
    });
    await Promise.resolve();
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', method: 'ui/notifications/size-changed',
      params: { width: 320, height: 516 },
    });
  });

  it('preserves control identity across chrome re-renders and removes the now-current mode control on grant', async () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    const fullscreen = mounted.button('fullscreen');
    // Identity survives unrelated chrome re-renders (an action binding update).
    mounted.bind('save-workspace');
    expect(mounted.button('fullscreen')).toBe(fullscreen);

    (mounted.outer.frameElement as HTMLElement | null)?.focus();
    fullscreen.focus();
    fullscreen.click();
    const request = mounted.hostMessages().find((message) => message.method === 'ui/request-display-mode');
    expect(request?.params).toEqual({ mode: 'fullscreen' });
    mounted.send(mounted.host, { jsonrpc: '2.0', id: request!.id, result: { mode: 'fullscreen' } });
    await Promise.resolve();

    // Inside fullscreen the Fullscreen control would be a no-op — it is removed, not disabled.
    expect(mounted.outer.document.querySelector('[data-chrome-key="fullscreen"]')).toBeNull();
    expect(mounted.childMessages()).toContainEqual({
      jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
      params: expect.objectContaining({ displayMode: 'fullscreen' }),
    });
    expect(mounted.status()).toContain('granted: opened Fullscreen');
  });

  it('suppresses the idle status row entirely and forwards Escape as an inline display-mode request', async () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.bind('save-workspace');
    mounted.bind('reopen-workspace');
    // Everything bound and available, nothing pending: no "Ready." — the row is hidden.
    const statusElement = mounted.outer.document.getElementById('chrome-status') as HTMLElement;
    expect(statusElement.textContent).toBe('');
    expect(statusElement.hidden).toBe(true);

    mounted.button('fullscreen').click();
    const request = mounted.hostMessages().find((message) => message.method === 'ui/request-display-mode')!;
    mounted.send(mounted.host, { jsonrpc: '2.0', id: request.id, result: { mode: 'fullscreen' } });
    await Promise.resolve();
    expect(mounted.outer.document.body.dataset.displayMode).toBe('fullscreen');

    // Escape in the TEMPLATE document (not the child) requests inline restore.
    mounted.outer.document.dispatchEvent(new mounted.outer.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escape = [...mounted.hostMessages()].reverse().find((message) =>
      message.method === 'ui/request-display-mode' && String(message.id).startsWith('marshal-react-escape-'),
    );
    expect(escape?.params).toEqual({ mode: 'inline' });
    mounted.send(mounted.host, { jsonrpc: '2.0', id: escape!.id, result: { mode: 'inline' } });
    await Promise.resolve();
    expect(mounted.outer.document.body.dataset.displayMode).toBe('inline');
    // Back inline with all controls usable again: still no idle chatter.
    expect(statusElement.hidden).toBe(true);
  });

  it('fills the host viewport in fullscreen and restores intrinsic card height on return to inline', async () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 320, height: 420 },
    });
    expect(mounted.childFrame().style.height).toBe('420px');

    mounted.button('fullscreen').click();
    const request = [...mounted.hostMessages()].reverse().find((message) =>
      message.method === 'ui/request-display-mode',
    )!;
    mounted.send(mounted.host, { jsonrpc: '2.0', id: request.id, result: { mode: 'fullscreen' } });
    await Promise.resolve();

    expect(mounted.outer.document.body.dataset.displayMode).toBe('fullscreen');
    expect(mounted.childFrame().style.height).toBe('');
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', method: 'ui/notifications/size-changed',
      params: { width: 320, height: 700 },
    });

    mounted.send(mounted.host, {
      jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
      params: { displayMode: 'inline' },
    });
    await Promise.resolve();
    expect(mounted.outer.document.body.dataset.displayMode).toBe('inline');
    expect(mounted.childFrame().style.height).toBe('420px');
  });

  it('polls a live workspace after initial mount and swaps only the child iframe for a new revision', async () => {
    vi.useFakeTimers();
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render({
      componentId: 'b'.repeat(64),
      componentHtml: componentHtml('Initial live revision'),
      workspace: workspaceStatus('b'.repeat(64), 'current', 1),
    });
    const mount = mounted.outer.document.querySelector('#mount');
    const chrome = mounted.outer.document.querySelector('#chrome');
    const initialFrame = mounted.childFrame();

    await vi.advanceTimersByTimeAsync(1_499);
    expect(mounted.hostMessages().filter((message) => message.method === 'tools/call')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const poll = mounted.hostMessages().find((message) => message.method === 'tools/call');
    expect(poll).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'marshal_get_react_payload',
        arguments: { renderId: 'a'.repeat(64) },
      },
    });

    mounted.send(mounted.host, {
      jsonrpc: '2.0',
      id: poll!.id,
      result: rendererResult({
        componentId: 'c'.repeat(64),
        componentHtml: componentHtml('Updated live revision'),
        workspace: workspaceStatus('c'.repeat(64), 'updated', 2),
      }),
    });
    await Promise.resolve();

    const updatedFrame = mounted.childFrame();
    expect(mounted.outer.document.querySelector('#mount')).toBe(mount);
    expect(mounted.outer.document.querySelector('#chrome')).toBe(chrome);
    expect(updatedFrame).not.toBe(initialFrame);
    expect(initialFrame.isConnected).toBe(false);
    expect(mounted.outer.document.querySelectorAll('#mount > iframe')).toHaveLength(1);
    expect(updatedFrame.srcdoc).toContain('Updated live revision');
  });

  it('cancels timed-out display-mode requests and quarantines a late host grant', async () => {
    vi.useFakeTimers();
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.button('fullscreen').click();
    const request = [...mounted.hostMessages()].reverse().find((message) =>
      message.method === 'ui/request-display-mode',
    )!;
    await vi.advanceTimersByTimeAsync(UI_CHROME_ACTION_TIMEOUT_MS);
    expect(mounted.status()).toBe('timed_out: Fullscreen request timed out; kept inline.');
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: request.id },
    });

    const childMessageCount = mounted.childMessages().length;
    mounted.send(mounted.host, { jsonrpc: '2.0', id: request.id, result: { mode: 'fullscreen' } });
    await Promise.resolve();
    expect(mounted.status()).toBe('timed_out: Fullscreen request timed out; kept inline.');
    const lateMessages = mounted.childMessages().slice(childMessageCount);
    expect(lateMessages).not.toContainEqual(expect.objectContaining({ id: request.id }));
    expect(lateMessages).not.toContainEqual(expect.objectContaining({
      method: 'ui/notifications/host-context-changed',
      params: expect.objectContaining({ displayMode: 'fullscreen' }),
    }));
  });

  it('bridges Save and Reopen once each and preserves typed action outcomes', async () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.bind('save-workspace');
    mounted.bind('reopen-workspace');

    for (const [actionId, status] of [
      ['save-workspace', 'success'],
      ['reopen-workspace', 'approval_required'],
    ] as const) {
      const before = mounted.childMessages().length;
      mounted.button(actionId).click();
      const requests = mounted.childMessages().slice(before).filter((message) =>
        message.method === UI_CHROME_ACTION_REQUEST_METHOD,
      );
      expect(requests).toHaveLength(1);
      const params = requests[0]!.params as { requestId: string; actionId: string };
      expect(params.actionId).toBe(actionId);
      expect(params).toMatchObject({ activatedAt: expect.any(String) });
      mounted.send(mounted.child, {
        jsonrpc: '2.0', method: UI_CHROME_ACTION_RESULT_METHOD,
        params: { ...params, status, message: `${actionId} outcome` },
      });
      expect(mounted.status()).toBe(`${status}: ${actionId} outcome`);
    }
  });

  it('attaches renderer-owned activation evidence to exactly one bound action dispatch', () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.bind('save-workspace');
    mounted.button('save-workspace').click();
    const request = [...mounted.childMessages()].reverse().find((message) =>
      message.method === UI_CHROME_ACTION_REQUEST_METHOD,
    )!;
    const activation = request.params as { requestId: string; actionId: string; activatedAt: string };
    mounted.send(mounted.child, {
      jsonrpc: '2.0', id: 'bound-action', method: 'tools/call',
      params: {
        name: UI_ACTION_TOOL_NAME,
        arguments: {
          actionId: activation.actionId, input: {}, scope: 'project',
          activationRequestId: activation.requestId,
        },
      },
    });
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', id: 'bound-action', method: 'tools/call',
      params: {
        name: UI_ACTION_TOOL_NAME,
        arguments: expect.objectContaining({
          renderId: 'a'.repeat(64),
          actionId: 'save-workspace',
          activation: {
            requestId: activation.requestId,
            surface: 'outer-renderer-chrome',
            method: UI_CHROME_ACTION_REQUEST_METHOD,
            activatedAt: activation.activatedAt,
            dispatchedAt: expect.any(String),
          },
        }),
      },
    });
  });

  it('forwards cancellation only for a child request admitted by the render-bound bridge', () => {
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.send(mounted.child, {
      jsonrpc: '2.0', id: 'child-action-1', method: 'tools/call',
      params: {
        name: UI_ACTION_TOOL_NAME,
        arguments: { actionId: 'save-workspace', input: {}, scope: 'project' },
      },
    });
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', id: 'child-action-1', method: 'tools/call',
      params: {
        name: UI_ACTION_TOOL_NAME,
        arguments: {
          renderId: 'a'.repeat(64), actionId: 'save-workspace', input: {}, scope: 'project',
        },
      },
    });

    const beforeForeign = mounted.hostMessages().length;
    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'foreign-request' },
    });
    expect(mounted.hostMessages()).toHaveLength(beforeForeign);
    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'child-action-1' },
    });
    expect(mounted.hostMessages()).toContainEqual({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'child-action-1' },
    });
    const afterAccepted = mounted.hostMessages().length;
    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'child-action-1' },
    });
    expect(mounted.hostMessages()).toHaveLength(afterAccepted);
  });

  it('allows cancellation, times out bounded actions, and ignores late results', async () => {
    vi.useFakeTimers();
    const mounted = mountRenderer();
    mounted.initialize();
    mounted.render();
    mounted.bind('save-workspace');
    mounted.bind('reopen-workspace');

    mounted.button('save-workspace').click();
    expect(mounted.button('save-workspace').textContent).toBe('Cancel Save workspace');
    mounted.button('save-workspace').click();
    expect(mounted.childMessages()).toContainEqual({
      jsonrpc: '2.0', method: UI_CHROME_ACTION_CANCEL_METHOD,
      params: expect.objectContaining({ actionId: 'save-workspace' }),
    });
    expect(mounted.status()).toContain('cancelled: Save workspace was cancelled');

    mounted.button('reopen-workspace').click();
    const pending = [...mounted.childMessages()].reverse().find((message) =>
      message.method === UI_CHROME_ACTION_REQUEST_METHOD,
    )!;
    await vi.advanceTimersByTimeAsync(UI_CHROME_ACTION_TIMEOUT_MS);
    expect(mounted.status()).toContain('timed_out: Reopen workspace timed out');
    mounted.send(mounted.child, {
      jsonrpc: '2.0', method: UI_CHROME_ACTION_RESULT_METHOD,
      params: { ...(pending.params as object), status: 'success', message: 'late success' },
    });
    expect(mounted.status()).toContain('timed_out: Reopen workspace timed out');
  });
});

type RenderFixture = {
  componentId?: string;
  componentHtml?: string;
  workspace?: Record<string, unknown>;
};

function mountRenderer() {
  const host = new Window({ url: 'https://host.example/' });
  const frame = host.document.createElement('iframe');
  host.document.body.append(frame);
  const outer = frame.contentWindow!;
  Object.defineProperty(outer, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(outer, 'innerHeight', { configurable: true, value: 700 });
  Object.defineProperties(outer, {
    setTimeout: { configurable: true, value: setTimeout },
    clearTimeout: { configurable: true, value: clearTimeout },
  });
  const html = reactUiTemplateContent().text;
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  if (!script) throw new Error('Renderer script missing.');
  outer.document.write(html.replace(/<script>[\s\S]+<\/script>/, ''));
  const postedToHost: UiProtocolMessage[] = [];
  Object.defineProperty(host, 'postMessage', {
    configurable: true,
    value: (message: UiProtocolMessage) => postedToHost.push(message),
  });
  outer.eval(script);

  const send = (source: Window, data: UiProtocolMessage) => {
    outer.dispatchEvent(new outer.MessageEvent('message', { data, source: source as never }));
  };
  const initialize = () => send(host, {
    jsonrpc: '2.0', id: 'marshal-react-renderer-init', result: {
      protocolVersion: '2026-01-26',
      hostCapabilities: {},
      hostContext: {
        displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        containerDimensions: { width: 320, height: 700 },
      },
    },
  });
  const render = (fixture: RenderFixture = {}) => send(host, {
    jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
      structuredContent: {
        render: { id: 'a'.repeat(64), componentId: fixture.componentId ?? 'b'.repeat(64), title: 'Mounted app' },
        application,
        props: {},
        ...(fixture.workspace ? { workspace: fixture.workspace } : {}),
      },
      _meta: {
        marshal: {
          kind: 'compiled_react_ui',
          componentId: fixture.componentId ?? 'b'.repeat(64),
          componentHtml: fixture.componentHtml ?? componentHtml('Mounted child'),
          application,
          storage: {},
          ...(fixture.workspace ? { workspace: fixture.workspace } : {}),
        },
      },
    },
  });
  const childMessages = () => {
    const current = outer.document.querySelector('iframe')?.contentWindow;
    return ((current as unknown as { __messages?: UiProtocolMessage[] })?.__messages ?? []);
  };
  const installChildCapture = () => {
    const current = outer.document.querySelector('iframe')?.contentWindow;
    if (!current) throw new Error('Mounted child missing.');
    const messages: UiProtocolMessage[] = [];
    Object.defineProperty(current, '__messages', { configurable: true, value: messages });
    Object.defineProperty(current, 'postMessage', {
      configurable: true,
      value: (message: UiProtocolMessage) => messages.push(message),
    });
    return current;
  };
  let capturedChild: Window | undefined;
  return {
    host,
    outer,
    html,
    send,
    initialize,
    render(fixture?: RenderFixture) {
      render(fixture);
      capturedChild = installChildCapture();
    },
    get child() {
      if (!capturedChild) throw new Error('Call render first.');
      return capturedChild;
    },
    hostMessages: () => postedToHost,
    childMessages,
    childFrame() {
      const current = outer.document.querySelector<HTMLIFrameElement>('#mount iframe');
      if (!current) throw new Error('Mounted child frame missing.');
      return current;
    },
    bind(actionId: string) {
      send(this.child, {
        jsonrpc: '2.0', method: UI_CHROME_ACTION_BINDING_METHOD,
        params: { actionId, bound: true },
      });
    },
    button(key: string) {
      const button = outer.document.querySelector<HTMLButtonElement>(`button[data-chrome-key="${key}"]`);
      if (!button) throw new Error(`Missing chrome button ${key}.`);
      return button;
    },
    status: () => outer.document.querySelector('#chrome-status')?.textContent ?? '',
  };
}

function componentHtml(content: string): string {
  return `<!doctype html><html><head><meta name="marshal-props" content=""><meta name="marshal-storage" content=""><meta name="marshal-runtime" content=""></head><body><main>${content}</main></body></html>`;
}

function workspaceStatus(
  componentId: string,
  status: 'current' | 'updated',
  revision: number,
): Record<string, unknown> {
  return {
    live: true,
    status,
    checkedAt: '2026-08-04T00:00:00.000Z',
    componentId,
    sourceDigest: 'd'.repeat(64),
    bundleDigest: 'e'.repeat(64),
    revision,
    dependencyCount: 1,
    pollIntervalMs: 1_500,
  };
}

function rendererResult(fixture: Required<RenderFixture>) {
  return {
    structuredContent: {
      render: { id: 'a'.repeat(64), componentId: fixture.componentId, title: 'Mounted app' },
      application,
      props: {},
      workspace: fixture.workspace,
    },
    _meta: {
      marshal: {
        kind: 'compiled_react_ui',
        componentId: fixture.componentId,
        componentHtml: fixture.componentHtml,
        application,
        storage: {},
        workspace: fixture.workspace,
      },
    },
  };
}

const application: UiApplicationManifest = {
  version: '1.0.0',
  presentationModes: ['inline', 'fullscreen', 'pip'],
  actions: [
    action('save-workspace', 'Save workspace'),
    action('reopen-workspace', 'Reopen workspace'),
  ],
  tools: [],
  localState: { scope: 'project', schemaVersion: '1.0.0' },
};

function action(id: string, title: string): UiApplicationManifest['actions'][number] {
  return {
    id, title, version: '1.0.0',
    target: { kind: 'capability', capability: `workspace.${id}` },
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    allowedScopes: ['project'], requiredPermissions: [], risk: 'write', idempotency: 'supported',
  };
}
