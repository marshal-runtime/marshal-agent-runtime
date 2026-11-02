import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexRuntime } from '../runtime.js';

interface DeclarativeCreateOutput {
  artifact: {
    id: string;
    resourceUri: string;
    document: { title: string };
  };
  resource: {
    uri: string;
    mimeType: string;
  };
}

describe('Codex production discovery catalog', () => {
  it('returns skills, resources, selected host tools, and UI applications additively', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-codex-discovery-'));
    const workspacePath = path.join(root, 'workspace');
    const previousUiStateRoot = process.env.MARSHAL_RUNTIME_UI_STATE_ROOT;
    let runtime: Awaited<ReturnType<typeof createCodexRuntime>> | undefined;

    try {
      process.env.MARSHAL_RUNTIME_UI_STATE_ROOT = path.join(root, 'ui-state');
      await fs.mkdir(workspacePath);
      const principal = { id: 'codex-discovery', kind: 'agent' } as const;
      runtime = await createCodexRuntime({
        workspacePath,
        stateDirectory: '.marshal-discovery',
        protectedLifecycleResultRoot: path.join(root, 'protected-lifecycle'),
        worktreeRoot: path.join(root, 'worktrees'),
        permissionProfile: 'trusted-local',
        principal,
        capabilities: { reactUi: { enabled: false } },
      });
      const context = { sessionId: 'catalog-session' };
      const created = await runtime.kernel.execute(
        {
          targetType: 'operation',
          target: 'ui.artifacts.create',
          input: {
            document: {
              protocolVersion: '1.0.0',
              title: 'Runtime discovery application',
              description: 'Production UI application for runtime discovery.',
              root: {
                type: 'text',
                id: 'root',
                text: 'Runtime discovery application',
              },
            },
          },
        },
        context,
      );
      expect(created).toMatchObject({
        status: 'success',
        result: {
          output: {
            artifact: {
              document: {
                title: 'Runtime discovery application',
              },
            },
          },
        },
      });
      const createdOutput = created.result?.output as DeclarativeCreateOutput | undefined;
      if (!createdOutput) throw new Error('Declarative UI creation did not return output');
      expect(createdOutput.resource).toMatchObject({
        uri: createdOutput.artifact.resourceUri,
        mimeType: 'text/html;profile=mcp-app',
      });

      const search = await runtime.kernel.search(
        { query: 'runtime', limit: 50 },
        context,
      );
      expect(search.matches.some((match) =>
        match.capability.name.startsWith('runtime.'))).toBe(true);

      const discoveries = search.discoveries ?? [];
      const skill = discoveries.find(({ entry }) =>
        entry.kind === 'skill'
        && entry.id === 'skill://marshal.runtime/use-marshal-runtime');
      const resource = discoveries.find(({ entry }) =>
        entry.kind === 'resource'
        && entry.action.type === 'resource_read'
        && entry.action.uri === 'skill://marshal.runtime/use-marshal-runtime');
      const hostTool = discoveries.find(({ entry }) =>
        entry.kind === 'host_tool'
        && entry.action.type === 'host_tool'
        && entry.action.toolId === 'runtime_exec');
      const uiApplication = discoveries.find(({ entry }) =>
        entry.kind === 'ui_application'
        && entry.title === 'Runtime discovery application');

      expect(skill).toBeDefined();
      expect(resource).toBeDefined();
      expect(hostTool).toBeDefined();
      expect(uiApplication).toBeDefined();
      expect(uiApplication).toMatchObject({
        entry: {
          id: `ui://marshal-declarative/artifact/${createdOutput.artifact.id}`,
          action: {
            type: 'ui_render',
            renderId: createdOutput.artifact.id,
            resourceUri: createdOutput.artifact.resourceUri,
          },
        },
      });
      expect(resource).toMatchObject({
        entry: {
          id:
            `catalog://marshal.runtime-resource-catalog/resource/${
              encodeURIComponent('skill://marshal.runtime/use-marshal-runtime')
            }`,
          metadata: {
            owner: {
              type: 'package',
              id: '@marshal/runtime',
            },
            packageId: '@marshal/runtime',
            skillId: 'marshal.runtime/use-marshal-runtime',
          },
        },
      });
      expect(hostTool).toMatchObject({
        entry: {
          id: 'catalog://marshal.codex-host-tools/host-tool/runtime_exec',
          metadata: {
            owner: {
              type: 'adapter',
              id: 'codex',
            },
            manifestLabels: expect.arrayContaining(['marshal.tool.execution']),
          },
        },
      });
      expect(discoveries
        .filter(({ entry }) => entry.kind === 'host_tool')
        .map(({ entry }) =>
          entry.action.type === 'host_tool' ? entry.action.toolId : undefined)
        .sort()).toEqual(['runtime_exec', 'runtime_search']);

      for (const discovery of [skill!, resource!, hostTool!, uiApplication!]) {
        await expect(runtime.kernel.search(
          { catalogId: discovery.entry.id },
          context,
        )).resolves.toMatchObject({
          matches: [],
          discoveries: [
            expect.objectContaining({
              entry: expect.objectContaining({
                id: discovery.entry.id,
                kind: discovery.entry.kind,
              }),
            }),
          ],
        });
      }

      await expect(runtime.resources?.readResource(
        'skill://marshal.runtime/use-marshal-runtime',
        context,
      )).resolves.toMatchObject({
        mimeType: 'text/markdown',
        text: expect.stringContaining('Marshal Runtime'),
      });
      await expect(runtime.resources?.readResource(
        createdOutput.artifact.resourceUri,
        context,
      )).resolves.toMatchObject({
        uri: createdOutput.artifact.resourceUri,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('Runtime discovery application'),
      });
    } finally {
      await runtime?.dispose();
      if (previousUiStateRoot === undefined) {
        delete process.env.MARSHAL_RUNTIME_UI_STATE_ROOT;
      } else {
        process.env.MARSHAL_RUNTIME_UI_STATE_ROOT = previousUiStateRoot;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
