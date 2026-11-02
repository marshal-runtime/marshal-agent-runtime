import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRuntimeKernel } from '../../../packages/agent-runtime-core/dist/index.js';
import { createRuntimeDelegationProvider } from '../../../packages/agent-runtime-delegation/dist/index.js';
import { createTypeScriptModuleProvider } from '../../../packages/agent-runtime-host/dist/index.js';
import { createArtifactProvider } from '../../../packages/agent-runtime-provider-artifacts/dist/index.js';
import {
  UI_ACTION_TOOL_NAME,
  createReactUiCapabilities,
} from '../../../packages/agent-runtime-ui/dist/index.js';

const publicationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(publicationRoot, '..', '..');
const capstoneRoot = join(publicationRoot, 'design-studio');
const CODEX_OUTER_TIMEOUT_CEILING_MS = 180_000;
const CAPSTONE_MODULE_TIMEOUT_MS = 170_000;

// TODO(#11): Capability output schema rejects request and scope fields.
test.skip('design-studio rehearsal composes host-defined TypeScript delegation, UI actions, and restart recovery', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'marshal-design-studio-capstone-'));
  const context = {
    principal: { id: 'capstone-rehearsal', kind: 'agent' },
    scope: { workspaceId: 'product-design-brief', projectId: 'atlas-launch', sessionId: 'build' },
  };
  const sourcePath = join(capstoneRoot, 'DesignStudio.tsx');
  const sourceDigest = await digestFile(sourcePath);
  const application = JSON.parse(await readFile(join(capstoneRoot, 'application.json'), 'utf8'));
  const fallback = JSON.parse(await readFile(join(capstoneRoot, 'fallback.json'), 'utf8'));
  const brief = JSON.parse(await readFile(join(capstoneRoot, 'brief.json'), 'utf8'));
  const delegation = scriptedDelegationProvider();
  const kernel = createRuntimeKernel({ permissionBroker: { decide: () => ({ decision: 'allow' }) } });
  kernel.register(delegation.provider);
  kernel.register(createArtifactProvider({ rootDirectory: join(stateRoot, 'artifacts') }));
  const moduleProvider = createTypeScriptModuleProvider({
    kernel,
    workspacePath: repositoryRoot,
    maxBrokerInvocations: 16,
    maxConcurrentBrokerInvocations: 3,
    timeoutMs: 10_000,
    maxTimeoutMs: CODEX_OUTER_TIMEOUT_CEILING_MS,
  });
  kernel.register(moduleProvider);
  const actionRuntime = kernelActionRuntime(kernel);
  const firstUi = createReactUiCapabilities({
    workspacePath: repositoryRoot,
    stateRoot: join(stateRoot, 'ui'),
    actionRuntime,
  });
  kernel.register(firstUi.provider);

  try {
    const orchestrated = await stage('orchestration', kernel.execute({
      protocolVersion: '1.0.0',
      targetType: 'module',
      module: {
        kind: 'workspace_file',
        path: 'examples/publication/design-studio/orchestrate-directions.ts',
      },
      input: brief,
      timeoutMs: CAPSTONE_MODULE_TIMEOUT_MS,
    }, context));
    assert.equal(orchestrated.status, 'success');
    const orchestrationOutput = moduleValue(orchestrated);
    assert.deepEqual(orchestrationOutput.synthesis, {
      status: 'success',
      requested: 3,
      accepted: 3,
      succeeded: 3,
      usable: 3,
      complete: true,
    });
    assert.equal(orchestrationOutput.directions.length, 3);
    assert.deepEqual(
      orchestrationOutput.directions.map(({ id, name }) => ({ id, name })),
      [
        { id: 'systems', name: 'Quiet Systems' },
        { id: 'interaction', name: 'Guided Momentum' },
        { id: 'editorial', name: 'Editorial Field' },
      ],
      'directions must remain mapped by delegationId',
    );
    assert.equal(delegation.spawnCount, 3);
    assert.equal(delegation.waitCount, 3);
    assert.equal(delegation.cancelCount, 0);
    assert.equal(delegation.nonTerminalCount, 0);
    assert.equal(delegation.peakConcurrency, 3);
    const broker = orchestrated.receipt?.providerReceipt?.broker;
    assert.equal(broker?.invocationCount, 6);
    assert.equal(broker?.peakConcurrency, 3);
    assert.deepEqual(
      broker?.children.map((child) => child.target).sort(),
      [
        'runtime.delegation.spawn',
        'runtime.delegation.spawn',
        'runtime.delegation.spawn',
        'runtime.delegation.wait',
        'runtime.delegation.wait',
        'runtime.delegation.wait',
      ],
    );
    const refinementInstruction = 'Make the information hierarchy calmer and strengthen the mobile frame.';
    const initialWorkspace = designWorkspace({
      projectName: brief.projectName,
      brief: brief.brief,
      directions: orchestrationOutput.directions,
      selectedDirectionId: orchestrationOutput.directions[1].id,
    });

    const compiled = await stage('compile', kernel.execute({
      protocolVersion: '1.0.0',
      targetType: 'operation',
      target: 'ui.compile',
      input: {
        entryPath: 'examples/publication/design-studio/DesignStudio.tsx',
        title: 'Design Studio capstone rehearsal',
        authoringProfile: application.authoringProfile,
      },
    }, context));
    assert.equal(compiled.status, 'success');
    const componentId = String(operationOutput(compiled).component.id);
    const rendered = await stage('render', kernel.execute({
      protocolVersion: '1.0.0',
      targetType: 'operation',
      target: 'ui.render',
      input: {
        componentId,
        props: {
          projectName: brief.projectName,
          brief: brief.brief,
          directions: initialWorkspace.directions,
          workspaceVersion: initialWorkspace.version,
        },
        fallback,
        application,
      },
    }, context));
    assert.equal(rendered.status, 'success');
    const renderId = String(operationOutput(rendered).render.id);
    const mounted = await stage('mount', firstUi.resources.invokeRenderTool('runtime_render_component', { renderId }, context));
    assert.equal(mounted?.structuredContent.render.id, renderId);
    assert.deepEqual(mounted?.structuredContent.application.presentationModes, ['inline', 'fullscreen', 'pip']);

    const seeded = await stage('initial authoritative save', firstUi.resources.invokeRenderTool(UI_ACTION_TOOL_NAME, {
      renderId,
      actionId: 'save-workspace',
      input: { workspace: initialWorkspace },
      scope: 'project',
      idempotencyKey: 'capstone-initial-workspace-v1',
    }, context));
    assert.equal(seeded?.structuredContent.status, 'success', JSON.stringify(seeded?.structuredContent, null, 2));
    assert.equal(seeded?.structuredContent.output.workspace.version, 1);
    assert.equal(seeded?.structuredContent.output.workspace.selectedDirectionId, orchestrationOutput.directions[1].id);
    assert.equal(seeded?.structuredContent.output.artifact.path, 'design-studio/workspace.json');

    const refined = await stage('ui action', firstUi.resources.invokeRenderTool(UI_ACTION_TOOL_NAME, {
      renderId,
      actionId: 'refine-design',
      input: {
        projectName: brief.projectName,
        directionId: orchestrationOutput.directions[1].id,
        frameId: 'mobile',
        instruction: refinementInstruction,
        expectedVersion: 1,
      },
      scope: 'project',
      idempotencyKey: 'capstone-targeted-refinement-v1',
    }, context));
    assert.equal(refined?.structuredContent.status, 'success', JSON.stringify(refined?.structuredContent, null, 2));
    assert.equal(refined?.structuredContent.output.refinement.editBoundary, 'selected-direction-responsive-frame-only');
    assert.equal(refined?.structuredContent.output.refinement.frameId, 'mobile');
    assert.equal(refined?.structuredContent.output.refinement.previousVersion, 1);
    assert.equal(refined?.structuredContent.output.refinement.nextVersion, 2);
    assert.equal(refined?.structuredContent.output.workspace.version, 2);
    const refinedDirections = refined.structuredContent.output.workspace.directions;
    assert.deepEqual(refinedDirections[0], initialWorkspace.directions[0], 'an unrelated direction must remain unchanged');
    assert.deepEqual(refinedDirections[2], initialWorkspace.directions[2], 'an unrelated direction must remain unchanged');
    const refinedSelected = refinedDirections[1];
    assert.equal(refinedSelected.responsive.selectedFrameId, 'mobile');
    assert.equal(
      refinedSelected.responsive.frames.find((frame) => frame.id === 'mobile')?.refinement,
      refinementInstruction,
    );
    assert.equal(
      refinedSelected.responsive.frames.find((frame) => frame.id === 'desktop')?.refinement,
      undefined,
      'targeted mobile refinement must not rewrite the desktop frame',
    );
    assert.equal(refined?.structuredContent.receipt.targetReceipt.target, 'runtime.module.execute');

    await stage('state write', firstUi.resources.invokeRenderTool('marshal_update_react_state', {
      renderId,
      operation: 'set',
      key: 'selected-direction',
      value: orchestrationOutput.directions[1].id,
    }, context));
    const restartedUi = createReactUiCapabilities({
      workspacePath: repositoryRoot,
      stateRoot: join(stateRoot, 'ui'),
      actionRuntime,
    });
    const reopened = await stage('restart reopen', restartedUi.resources.invokeRenderTool(
      'runtime_render_component',
      { renderId },
      { ...context, scope: { ...context.scope, sessionId: 'restored' } },
    ));
    assert.equal(reopened?.structuredContent.render.id, renderId);
    assert.equal(reopened?.structuredContent.render.componentId, componentId);
    const restored = await stage('authoritative restore', restartedUi.resources.invokeRenderTool(
      UI_ACTION_TOOL_NAME,
      {
        renderId,
        actionId: 'load-workspace',
        input: { projectName: brief.projectName },
        scope: 'project',
      },
      { ...context, scope: { ...context.scope, sessionId: 'restored' } },
    ));
    assert.equal(restored?.structuredContent.status, 'success', JSON.stringify(restored?.structuredContent, null, 2));
    assert.equal(restored?.structuredContent.output.workspace.version, 2);
    assert.equal(restored?.structuredContent.output.workspace.selectedDirectionId, orchestrationOutput.directions[1].id);
    assert.equal(
      restored?.structuredContent.output.workspace.directions[1].responsive.frames
        .find((frame) => frame.id === 'mobile')?.refinement,
      refinementInstruction,
    );
    assert.equal(restored?.structuredContent.output.artifact.path, 'design-studio/workspace.json');
    const reopenedPayload = await stage('restart payload', restartedUi.resources.invokeRenderTool(
      'marshal_get_react_payload',
      { renderId },
      { ...context, scope: { ...context.scope, sessionId: 'restored' } },
    ));
    assert.equal(reopenedPayload?.structuredContent.marshal.storage['selected-direction'], orchestrationOutput.directions[1].id);
    assert.equal(delegation.nonTerminalCount, 0);
    assert.equal(await digestFile(sourcePath), sourceDigest, 'reopen must not rewrite or recompile the source');
  } finally {
    await stage('module provider dispose', moduleProvider.dispose());
    await stage('teardown', rm(stateRoot, { recursive: true, force: true }));
  }
});

// TODO(#11): Capability output schema rejects request and scope fields.
test.skip('design-studio safely normalizes an overlong successful interaction and reports the normalization', async () => {
  const output = await executeOrchestrationFixture(
    { overlongInteractionIndex: 1 },
    'interaction-normalization',
  );
  assert.equal(output.synthesis.status, 'success');
  assert.equal(output.synthesis.complete, true);
  assert.equal(output.directions.length, 3, 'an overlong interaction must not drop a successful direction');
  const normalized = output.directions.find(({ id }) => id === 'interaction')?.interaction;
  assert.equal(Array.from(normalized ?? '').length, 800);
  assert.match(normalized ?? '', /…$/);
  assert.deepEqual(output.validationDiagnostics, [{
    delegationId: 'design-direction-2',
    assignment: 'interaction',
    outcomeState: 'succeeded',
    code: 'direction-interaction-truncated',
    message: 'Direction interaction exceeded 800 characters and was safely normalized.',
    observedCharacters: 900,
    normalizedCharacters: 800,
  }]);
});

// TODO(#11): Capability output schema rejects request and scope fields.
test.skip('design-studio surfaces validation diagnostics when a successful child is unusable', async () => {
  const output = await executeOrchestrationFixture(
    { missingInteractionIndex: 1 },
    'interaction-rejection',
  );
  assert.equal(output.synthesis.status, 'partial');
  assert.equal(output.synthesis.succeeded, 3);
  assert.equal(output.synthesis.usable, 2);
  assert.equal(output.synthesis.complete, false);
  assert.deepEqual(output.directions.map(({ id }) => id), ['systems', 'editorial']);
  assert.deepEqual(output.validationDiagnostics, [{
    delegationId: 'design-direction-2',
    assignment: 'interaction',
    outcomeState: 'succeeded',
    code: 'direction-interaction-invalid',
    message: 'Direction interaction must contain 1-800 characters.',
  }]);
});

async function stage(name, promise, timeoutMs = 15_000) {
  const startedAt = performance.now();
  console.error(`[capstone] ${name}: start`);
  let timer;
  try {
    const value = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    console.error(`[capstone] ${name}: ${Math.round(performance.now() - startedAt)}ms`);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function scriptedDelegationProvider(options = {}) {
  const baseResponses = [
    { name: 'Quiet Systems', premise: 'A restrained token-led workspace with calm hierarchy.', palette: ['#f4f1ea', '#31463a', '#b9c6b5'], interaction: 'Inspect and refine one system layer.' },
    { name: 'Guided Momentum', premise: 'A task-forward workspace built around explicit next actions.', palette: ['#fff7e8', '#c55232', '#263b50'], interaction: 'Advance milestones and refine a selected action.' },
    { name: 'Editorial Field', premise: 'A narrative canvas that pairs intent with concrete decisions.', palette: ['#f5efe6', '#5f496d', '#d4a15a'], interaction: 'Compare story panels and save a composition.' },
  ];
  const responses = baseResponses.map((response, index) => {
    if (options.overlongInteractionIndex === index) return { ...response, interaction: 'x'.repeat(900) };
    if (options.missingInteractionIndex === index) {
      const { interaction: _interaction, ...withoutInteraction } = response;
      return withoutInteraction;
    }
    return response;
  });
  const handles = new Map();
  let active = 0;
  let peakConcurrency = 0;
  let spawnCount = 0;
  let waitCount = 0;
  let cancelCount = 0;
  const manager = {
    async spawn(request, context) {
      const index = spawnCount++;
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      active -= 1;
      const delegationId = `design-direction-${index + 1}`;
      const record = {
        delegationId,
        adapterHandle: `host-${delegationId}`,
        state: 'done',
        request: { prompt: request.prompt },
        scope: context.scope,
        result: JSON.stringify(responses[index]),
      };
      handles.set(delegationId, record);
      return record;
    },
    async wait(request) {
      waitCount += 1;
      const record = handles.get(request.delegationId);
      if (!record) throw new Error(`Unknown delegation ${request.delegationId}`);
      return record;
    },
    async continue(request) {
      const record = handles.get(request.delegationId);
      if (!record) throw new Error(`Unknown delegation ${request.delegationId}`);
      return record;
    },
    async cancel(request) {
      cancelCount += 1;
      const record = handles.get(request.delegationId);
      if (!record) throw new Error(`Unknown delegation ${request.delegationId}`);
      const cancelled = { ...record, state: 'failed', error: 'cancelled' };
      handles.set(request.delegationId, cancelled);
      return [cancelled];
    },
  };
  return {
    get spawnCount() { return spawnCount; },
    get waitCount() { return waitCount; },
    get cancelCount() { return cancelCount; },
    get peakConcurrency() { return peakConcurrency; },
    get nonTerminalCount() {
      return [...handles.values()].filter(({ state }) => state === 'pending' || state === 'running').length;
    },
    provider: createRuntimeDelegationProvider({
      manager,
      providerId: 'publication.scripted-native-delegation',
    }),
  };
}

async function executeOrchestrationFixture(options, sessionId) {
  const stateRoot = await mkdtemp(join(tmpdir(), `marshal-design-studio-${sessionId}-`));
  const context = {
    principal: { id: `capstone-${sessionId}`, kind: 'agent' },
    scope: { workspaceId: 'product-design-brief', projectId: 'atlas-launch', sessionId },
  };
  const brief = JSON.parse(await readFile(join(capstoneRoot, 'brief.json'), 'utf8'));
  const delegation = scriptedDelegationProvider(options);
  const kernel = createRuntimeKernel({ permissionBroker: { decide: () => ({ decision: 'allow' }) } });
  kernel.register(delegation.provider);
  const moduleProvider = createTypeScriptModuleProvider({
    kernel,
    workspacePath: repositoryRoot,
    maxBrokerInvocations: 16,
    maxConcurrentBrokerInvocations: 3,
    timeoutMs: 10_000,
    maxTimeoutMs: CODEX_OUTER_TIMEOUT_CEILING_MS,
  });
  kernel.register(moduleProvider);
  try {
    const executed = await kernel.execute({
      protocolVersion: '1.0.0',
      targetType: 'module',
      module: {
        kind: 'workspace_file',
        path: 'examples/publication/design-studio/orchestrate-directions.ts',
      },
      input: brief,
      timeoutMs: CAPSTONE_MODULE_TIMEOUT_MS,
    }, context);
    assert.equal(executed.status, 'success');
    assert.equal(delegation.nonTerminalCount, 0);
    return moduleValue(executed);
  } finally {
    await moduleProvider.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function kernelActionRuntime(kernel) {
  return {
    authorize: {
      authorize(request) {
        return { decision: 'allow', grants: [...request.action.requiredPermissions] };
      },
    },
    executor: {
      async execute(request, context) {
        const target = request.action.target;
        const executed = target.kind === 'capability'
          ? await kernel.execute({ protocolVersion: '1.0.0', targetType: 'operation', target: target.capability, input: request.input }, context)
          : await kernel.execute({ protocolVersion: '1.0.0', targetType: 'module', module: target.module, input: request.input }, context);
        if (target.kind !== 'module' || executed.status !== 'success') return executed;
        const output = executed.result?.output;
        return output?.ok === true
          ? { ...executed, result: { ...executed.result, output: output.value } }
          : executed;
      },
    },
  };
}

function operationOutput(response) {
  return response.result?.output ?? {};
}

function moduleValue(response) {
  const output = operationOutput(response);
  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  return output.value;
}

function designWorkspace({ projectName, brief, directions, selectedDirectionId }) {
  return {
    projectName,
    brief,
    version: 1,
    selectedDirectionId,
    directions: directions.map((direction) => ({
      ...direction,
      responsive: {
        selectedFrameId: direction.id === selectedDirectionId ? 'mobile' : 'desktop',
        frames: [
          { id: 'desktop', label: 'Desktop', width: 1440, height: 960, notes: 'Wide canvas with persistent context.' },
          { id: 'tablet', label: 'Tablet', width: 834, height: 1112, notes: 'Balanced canvas for review and touch.' },
          { id: 'mobile', label: 'Mobile', width: 390, height: 844, notes: 'Focused single-column launch view.' },
        ],
      },
    })),
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

async function digestFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
