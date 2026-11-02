import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_EXTENSION_ACTION_TOOL,
  createRuntimeExtensionManagerView,
  renderRuntimeExtensionManagerHtml,
  runtimeExtensionActionToolMetadata,
  runtimeExtensionManagerToolMetadata,
} from '../extensionManager.js';

describe('runtime extension manager', () => {
  it('projects precise live states, package commands, diagnostics, configuration, and actions', () => {
    const statuses = [
      'detected-installable', 'detected-unbuilt', 'installing-building', 'installed-enabled',
      'installed-disabled', 'invalid', 'unreadable', 'failed',
    ] as const;
    const view = createRuntimeExtensionManagerView({
      revision: 7,
      status: 'ready',
      changedAt: '2026-08-29T00:00:00.000Z',
      roots: ['C:/extensions'],
      diagnostics: [{ code: 'root-warning', message: 'root warning', path: 'C:/extensions' }],
      entries: [...statuses.map((status, index) => ({
        key: `extension-${index}`,
        identity: `@test/extension-${index}`,
        version: '1.0.0',
        packageRoot: `C:/extensions/extension-${index}`,
        status,
        ...(status === 'installing-building' ? { installationPhase: 'running-script' } : {}),
        ...(status === 'detected-unbuilt' ? { installCommand: { packageManager: 'pnpm', script: 'build' } } : {}),
        configuration: { defaults: {}, values: { enabledFeature: true } },
        diagnostics: status === 'invalid' ? [{ code: 'manifest-invalid', message: 'bad manifest' }] : [],
      })), {
        key: 'ordinary-workspace-package',
        packageRoot: 'C:/extensions/ordinary-workspace-package',
        status: 'invalid',
        configuration: { defaults: {} },
        diagnostics: [{ code: 'manifest_missing', message: 'not an extension package' }],
      }],
    }, [{
      identity: '@test/extension-3', health: 'blocked',
      blockReasons: [{ message: 'dependency unavailable' }], configurationValues: { enabledFeature: true },
      capabilityProviderIds: ['@test/extension-3:provider'],
    }], {
      globalEnabled: true,
      extensions: [{ identity: '@test/extension-3', enabled: true }],
    });

    expect(view.entries.map((entry) => entry.statusLabel)).toEqual([
      'Detected', 'Build required', 'Installing / building', 'Installed and enabled',
      'Installed and disabled', 'Invalid', 'Unreadable', 'Failed',
    ]);
    expect(view.entries.some((entry) => entry.key === 'ordinary-workspace-package')).toBe(false);
    expect(view.entries[1]).toMatchObject({ packageManager: 'pnpm', installCommand: 'pnpm run build', actions: ['install'] });
    expect(view.entries[3]).toMatchObject({ blocked: true, blockReasons: ['dependency unavailable'], actions: ['remove', 'configure'] });
    expect(view).toMatchObject({ globalAutopilot: true });
    expect(view.entries[3]).toMatchObject({ autopilot: true });
    const html = renderRuntimeExtensionManagerHtml(view);
    expect(html).toContain(RUNTIME_EXTENSION_ACTION_TOOL);
    expect(html).toContain('Install and build');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('Open fullscreen');
    expect(html).toContain('Global autopilot: ');
    expect(html).toContain('Autopilot: ');
    expect(html).toContain('set-global-autopilot');
    expect(html).toContain('set-extension-autopilot');
    expect(html).toContain("ui/request-display-mode");
    expect(html).toContain("availableDisplayModes:['inline','fullscreen']");
    expect(html).toContain("e.status==='installing-building'");
    expect(html).toContain("setTimeout(()=>void act(undefined,{action:'refresh'}),1000)");
    expect(html).toContain("setTimeout(()=>void act(undefined,{action:'refresh'}),0)");
    expect(runtimeExtensionManagerToolMetadata()).toMatchObject({
      ui: { resourceUri: 'ui://marshal-runtime/extensions' },
      'openai/widgetAccessible': true,
    });
    expect(runtimeExtensionActionToolMetadata()).toMatchObject({
      ui: { visibility: ['model', 'app'] },
      'openai/widgetAccessible': true,
    });
    expect(runtimeExtensionActionToolMetadata()).not.toHaveProperty('ui.resourceUri');
    expect(html).not.toContain('dependency unavailable</script>');
    const scriptStart = html.lastIndexOf('<script>') + '<script>'.length;
    const script = html.slice(scriptStart, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });

  it('posts JSON-compatible install arguments and adds autopilot after a live install', async () => {
    const view = createRuntimeExtensionManagerView({
      revision: 1,
      status: 'ready',
      changedAt: '2026-08-29T00:00:00.000Z',
      roots: ['C:/extensions'],
      diagnostics: [],
      entries: [{
        key: '@test/live',
        identity: '@test/live',
        version: '1.0.0',
        packageRoot: 'C:/extensions/live',
        status: 'detected-installable',
        configuration: { defaults: {} },
        diagnostics: [],
      }],
    });
    const host = new Window({ url: 'https://host.example/' });
    const frame = host.document.createElement('iframe');
    host.document.body.append(frame);
    const outer = frame.contentWindow!;
    const html = renderRuntimeExtensionManagerHtml(view);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    if (scripts.length === 0) throw new Error('Runtime extension manager script missing');
    outer.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const posted: Array<Record<string, unknown>> = [];
    Object.defineProperty(host, 'postMessage', {
      configurable: true,
      value: (message: Record<string, unknown>) => posted.push(message),
    });

    try {
      for (const script of scripts) outer.eval(script);
      outer.document.querySelector<HTMLButtonElement>('button.primary')!.click();
      const call = [...posted].reverse().find((message) => message.method === 'tools/call');
      if (!call) throw new Error('Install tool call missing');
      const expected = {
        jsonrpc: '2.0',
        id: call.id,
        method: 'tools/call',
        params: {
          name: RUNTIME_EXTENSION_ACTION_TOOL,
          arguments: {
            action: 'install',
            identity: '@test/live',
            packageRoot: 'C:/extensions/live',
          },
        },
      };
      expect(call).toEqual(expected);
      const params = call.params as { arguments: Record<string, unknown> };
      expect(Object.hasOwn(params.arguments, 'configuration')).toBe(false);
      expect(JSON.parse(JSON.stringify(call))).toEqual(expected);

      const installedView = createRuntimeExtensionManagerView({
        revision: 2,
        status: 'ready',
        changedAt: '2026-08-29T00:00:01.000Z',
        roots: ['C:/extensions'],
        diagnostics: [],
        entries: [{
          key: '@test/live', identity: '@test/live', version: '1.0.0',
          packageRoot: 'C:/extensions/live', status: 'installed-enabled',
          configuration: { defaults: {}, values: {} }, diagnostics: [],
        }],
      }, [{
        identity: '@test/live', health: 'healthy', blockReasons: [], configurationValues: {},
        capabilityProviderIds: ['@test/live:provider'],
      }]);
      outer.dispatchEvent(new outer.MessageEvent('message', {
        source: host,
        data: { jsonrpc: '2.0', id: call.id, result: { structuredContent: { view: installedView } } },
      }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (outer.document.querySelector('[data-autopilot-extension]')) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(outer.document.querySelector<HTMLButtonElement>('[data-autopilot-extension]')?.textContent)
        .toBe('Autopilot: Off');
    } finally {
      host.close();
    }
  });
});
