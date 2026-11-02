import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRuntimeKernel } from '../../../packages/agent-runtime-core/dist/index.js';
import { createTypeScriptModuleProvider } from '../../../packages/agent-runtime-host/dist/index.js';
import { createArtifactProvider } from '../../../packages/agent-runtime-provider-artifacts/dist/index.js';

const publicationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(publicationRoot, '..', '..');
const studioRoot = join(publicationRoot, 'design-studio');
const modulePath = 'examples/publication/design-studio/refine-design.ts';

test('design-studio authoritative workspace saves, reloads, and refines only the selected responsive frame', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'marshal-design-studio-state-'));
  const fixtureEvidence = JSON.parse(await readFile(join(studioRoot, 'fixture-result.json'), 'utf8'));
  const fixture = fixtureEvidence.workspace;
  const application = JSON.parse(await readFile(join(studioRoot, 'application.json'), 'utf8'));
  const fallback = JSON.parse(await readFile(join(studioRoot, 'fallback.json'), 'utf8'));
  const context = {
    principal: { id: 'design-studio-state-test', kind: 'agent' },
    scope: { workspaceId: 'product-design-brief', projectId: 'atlas-launch', sessionId: 'state' },
  };
  const kernel = createRuntimeKernel({ permissionBroker: { decide: () => ({ decision: 'allow' }) } });
  kernel.register(createArtifactProvider({ rootDirectory: join(stateRoot, 'artifacts') }));
  const moduleProvider = createTypeScriptModuleProvider({
    kernel,
    workspacePath: repositoryRoot,
    maxBrokerInvocations: 4,
    maxConcurrentBrokerInvocations: 2,
    timeoutMs: 10_000,
    maxTimeoutMs: 30_000,
  });
  kernel.register(moduleProvider);

  try {
    assert.deepEqual(application.actions.map(({ id }) => id), ['refine-design', 'save-workspace', 'load-workspace']);
    assert.equal(fixtureEvidence.evidenceClass, 'generated-fixture');
    assert.equal(fixtureEvidence.notALiveRun, true);
    assert.deepEqual(application.authoritativeState, {
      capability: 'artifacts.read',
      resourceId: 'design-studio/workspace.json',
      version: '2.0.0',
    });
    assert.equal(fallback.details.canonicalState.path, 'design-studio/workspace.json');

    const saved = await executeModule(kernel, context, 'saveDesign', { workspace: fixture });
    assert.equal(saved.status, 'success');
    const savedValue = moduleValue(saved);
    assert.deepEqual(savedValue.workspace, fixture);
    assert.equal(savedValue.artifact.path, 'design-studio/workspace.json');
    assert.deepEqual(brokerTargets(saved), ['artifacts.write']);

    const loaded = await executeModule(kernel, context, 'loadDesign', { projectName: fixture.projectName });
    assert.equal(loaded.status, 'success');
    const loadedValue = moduleValue(loaded);
    assert.deepEqual(loadedValue.workspace, fixture);
    assert.equal(JSON.parse(loadedValue.artifact.content).version, 1);
    assert.deepEqual(brokerTargets(loaded), ['artifacts.read']);

    const instruction = 'Reduce the mobile hierarchy to one primary next action and preserve the milestone context.';
    const refined = await executeModule(kernel, context, 'default', {
      projectName: fixture.projectName,
      directionId: fixture.selectedDirectionId,
      frameId: 'mobile',
      instruction,
      expectedVersion: fixture.version,
    });
    assert.equal(refined.status, 'success');
    const refinedValue = moduleValue(refined);
    assert.equal(refinedValue.workspace.version, 2);
    assert.equal(refinedValue.refinement.editBoundary, 'selected-direction-responsive-frame-only');
    assert.equal(refinedValue.refinement.previousVersion, 1);
    assert.equal(refinedValue.refinement.nextVersion, 2);
    assert.deepEqual(brokerTargets(refined), ['artifacts.read', 'artifacts.write']);

    const originalSelected = fixture.directions.find(({ id }) => id === fixture.selectedDirectionId);
    const updatedSelected = refinedValue.workspace.directions.find(({ id }) => id === fixture.selectedDirectionId);
    assert.deepEqual(
      refinedValue.workspace.directions.filter(({ id }) => id !== fixture.selectedDirectionId),
      fixture.directions.filter(({ id }) => id !== fixture.selectedDirectionId),
      'directions outside the selected boundary must remain byte-for-byte equivalent as data',
    );
    assert.deepEqual(
      { ...updatedSelected, responsive: undefined },
      { ...originalSelected, responsive: undefined },
      'selected direction fields outside responsive state must not change',
    );
    const originalDesktop = originalSelected.responsive.frames.find(({ id }) => id === 'desktop');
    const updatedDesktop = updatedSelected.responsive.frames.find(({ id }) => id === 'desktop');
    const updatedMobile = updatedSelected.responsive.frames.find(({ id }) => id === 'mobile');
    assert.deepEqual(updatedDesktop, originalDesktop, 'non-selected responsive frames must not change');
    assert.equal(updatedMobile.refinement, instruction);
    assert.equal(typeof updatedMobile.updatedAt, 'string');

    const reopened = await executeModule(kernel, context, 'loadDesign', { projectName: fixture.projectName });
    assert.equal(reopened.status, 'success');
    assert.deepEqual(moduleValue(reopened).workspace, refinedValue.workspace, 'reload must return the persisted refined version');

    const stale = await executeModule(kernel, context, 'default', {
      projectName: fixture.projectName,
      directionId: fixture.selectedDirectionId,
      frameId: 'mobile',
      instruction: 'This stale write must be rejected.',
      expectedVersion: 1,
    });
    assert.equal(stale.status, 'success');
    assert.equal(stale.result?.output?.ok, false, JSON.stringify(stale.result?.output, null, 2));
    assert.match(stale.result?.output?.error?.message ?? '', /version conflict/);
    const afterStale = await executeModule(kernel, context, 'loadDesign', { projectName: fixture.projectName });
    assert.deepEqual(moduleValue(afterStale).workspace, refinedValue.workspace, 'a rejected stale refinement must not mutate state');
  } finally {
    await moduleProvider.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

function executeModule(kernel, context, moduleExport, input) {
  return kernel.execute({
    protocolVersion: '1.0.0',
    targetType: 'module',
    module: { kind: 'workspace_file', path: modulePath, export: moduleExport },
    input,
    timeoutMs: 30_000,
  }, context);
}

function moduleValue(response) {
  const output = response.result?.output ?? {};
  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  return output.value;
}

function brokerTargets(response) {
  return response.receipt?.providerReceipt?.broker?.children.map(({ target }) => target) ?? [];
}
