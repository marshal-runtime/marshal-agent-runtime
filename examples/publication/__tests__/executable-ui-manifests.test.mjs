import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  UI_ACTION_TOOL_NAME,
  createReactUiCapabilities,
} from '../../../packages/agent-runtime-ui/dist/index.js';

const publicationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(publicationRoot, '..', '..');
const cases = [
  ['design-studio', 'design-studio/DesignStudio.tsx', 'design-studio/application.json', 'design-studio/fallback.json'],
  ['presentation-adaptation', 'presentation-adaptation/AdaptiveStatus.tsx', 'presentation-adaptation/application.json', 'presentation-adaptation/fallback.json'],
  ['restart-recovery', 'restart-recovery/PersistentPanel.tsx', 'restart-recovery/application.json', 'restart-recovery/fallback.json'],
  ['ui-capability-action', 'ui-actions/ActionBoard.tsx', 'ui-actions/capability.application.json', 'ui-actions/capability.fallback.json'],
  ['ui-module-action', 'ui-actions/ActionBoard.tsx', 'ui-actions/module.application.json', 'ui-actions/module.fallback.json'],
];

test('exact publication UI manifests compile, bind, reopen, and invoke offline', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'marshal-publication-ui-'));
  const context = {
    principal: { id: 'publication-validator', kind: 'agent' },
    scope: { workspaceId: 'publication', projectId: 'publication', sessionId: 'first' },
  };
  let sequence = 0;
  const actionRuntime = {
    authorize: { authorize: (request) => ({ decision: 'allow', grants: [...request.action.requiredPermissions] }) },
    executor: {
      async execute(request) {
        const executionId = `publication-action-${++sequence}`;
        return {
          protocolVersion: '1.0.0',
          status: 'success',
          result: { output: actionOutput(request.action.id, request.input) },
          receipt: {
            protocolVersion: '1.0.0', receiptId: `receipt-${sequence}`, executionId,
            target: request.action.target.kind === 'capability'
              ? request.action.target.capability
              : 'runtime.module.execute',
            principalId: 'publication-validator',
            lineage: { rootExecutionId: executionId, depth: 0 }, status: 'success',
            startedAt: '2026-08-02T00:00:00.000Z', completedAt: '2026-08-02T00:00:00.000Z', durationMs: 0,
          },
        };
      },
    },
  };
  try {
    for (const [id, sourcePath, manifestPath, fallbackPath] of cases) {
      const source = join(publicationRoot, sourcePath);
      const beforeDigest = await digestFile(source);
      const application = JSON.parse(await readFile(join(publicationRoot, manifestPath), 'utf8'));
      const fallback = JSON.parse(await readFile(join(publicationRoot, fallbackPath), 'utf8'));
      const first = createReactUiCapabilities({ workspacePath: repositoryRoot, stateRoot, actionRuntime });
      const compiled = await first.provider.invoke('ui.compile', {
        entryPath: `examples/publication/${sourcePath}`,
        title: `Publication ${id}`,
        authoringProfile: application.authoringProfile,
      }, context);
      const componentId = String(compiled.output.component.id);
      const rendered = await first.provider.invoke('ui.render', {
        componentId,
        props: publicationProps(id),
        fallback,
        application,
      }, context);
      const renderId = String(rendered.output.render.id);
      await first.resources.invokeRenderTool('runtime_render_component', { renderId }, context);
      if (application.localState) {
        await first.resources.invokeRenderTool(
          'marshal_update_react_state',
          { renderId, operation: 'set', key: 'publication-validation', value: id },
          context,
        );
      }

      const restarted = createReactUiCapabilities({ workspacePath: repositoryRoot, stateRoot, actionRuntime });
      const reopened = await restarted.resources.invokeRenderTool(
        'runtime_render_component',
        { renderId },
        { ...context, scope: { ...context.scope, sessionId: 'restarted' } },
      );
      assert.equal(reopened?.structuredContent.render.id, renderId);
      for (const action of application.actions) {
        const invoked = await restarted.resources.invokeRenderTool(
          UI_ACTION_TOOL_NAME,
          {
            renderId,
            actionId: action.id,
            input: actionInput(action.id),
            scope: action.allowedScopes[0],
            ...(action.idempotency === 'none' ? {} : { idempotencyKey: `publication:${id}:${action.id}` }),
          },
          context,
        );
        assert.equal(invoked?.structuredContent.status, 'success');
      }
      assert.equal(await digestFile(source), beforeDigest, `${sourcePath} changed during validation`);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

function actionInput(id) {
  if (id === 'refine-design') {
    return {
      projectName: 'Marshal',
      directionId: 'calm',
      frameId: 'mobile',
      instruction: 'Tighten hierarchy.',
      expectedVersion: 1,
    };
  }
  if (id === 'save-workspace') return { workspace: publicationWorkspace() };
  if (id === 'load-workspace') return { projectName: 'Marshal' };
  if (id === 'search-memory') return { scope: 'project', query: 'publication risks', limit: 5 };
  if (id === 'update-priority') return { itemId: 'publication-demo', priority: 'high' };
  throw new Error(`No publication action input for ${id}`);
}

function actionOutput(id, input) {
  if (id === 'refine-design') {
    const workspace = publicationWorkspace({
      version: 2,
      refinement: input.instruction,
      updatedAt: '2026-08-03T00:01:00.000Z',
    });
    return {
      workspace,
      artifact: writtenWorkspaceArtifact(),
      refinement: {
        projectName: input.projectName,
        directionId: input.directionId,
        frameId: input.frameId,
        instruction: input.instruction,
        editBoundary: 'selected-direction-responsive-frame-only',
        previousVersion: input.expectedVersion,
        nextVersion: workspace.version,
        updatedAt: workspace.updatedAt,
      },
    };
  }
  if (id === 'save-workspace') return { workspace: input.workspace, artifact: writtenWorkspaceArtifact() };
  if (id === 'load-workspace') {
    const workspace = publicationWorkspace();
    const content = JSON.stringify(workspace);
    return {
      workspace,
      artifact: {
        path: 'design-studio/workspace.json',
        content,
        encoding: 'utf8',
        sizeBytes: Buffer.byteLength(content),
        scope: { projectId: 'publication' },
      },
    };
  }
  if (id === 'search-memory') return { memories: [] };
  if (id === 'update-priority') return { updated: true, record: {}, artifact: {} };
  throw new Error(`No publication action output for ${id}`);
}

function publicationProps(id) {
  if (id === 'design-studio') {
    return {
      projectName: 'Marshal', brief: 'Validate the exact publication manifest.',
      directions: publicationWorkspace().directions,
      workspaceVersion: 1,
    };
  }
  if (id.startsWith('ui-')) return { actionId: id === 'ui-capability-action' ? 'search-memory' : 'update-priority', title: id };
  return {};
}

function publicationWorkspace({ version = 1, refinement, updatedAt = '2026-08-03T00:00:00.000Z' } = {}) {
  return {
    projectName: 'Marshal',
    brief: 'Validate the exact publication manifest.',
    version,
    selectedDirectionId: 'calm',
    directions: [{
      id: 'calm',
      name: 'Calm',
      premise: 'Quiet hierarchy',
      palette: ['#111111', '#eeeeee', '#ffffff'],
      interaction: 'Direct',
      responsive: {
        selectedFrameId: 'mobile',
        frames: [
          { id: 'desktop', label: 'Desktop', width: 1440, height: 960 },
          {
            id: 'mobile',
            label: 'Mobile',
            width: 390,
            height: 844,
            ...(refinement ? { refinement, updatedAt } : {}),
          },
        ],
      },
    }],
    updatedAt,
  };
}

function writtenWorkspaceArtifact() {
  return {
    path: 'design-studio/workspace.json',
    sizeBytes: 512,
    mediaType: 'application/json',
    scope: { projectId: 'publication' },
  };
}

async function digestFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
