import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCandidateMEvidence,
  loadCandidateMPlan,
  sha256,
  validateCandidateMPlan,
} from '../candidate-m-acceptance-lib.mjs';

test('Candidate M plan preserves every prompt byte and the frozen v1 capstone', async () => {
  const plan = await loadCandidateMPlan();
  const result = await validateCandidateMPlan(plan);
  assert.equal(result.candidate, 'm');
  assert.equal(result.promptCount, 7);
  assert.equal(plan.ui.build.sha256, 'c9b0e64795a9f63668ec51b816dcebafe79cea2ca6b4c95b8a68a13cb41ed80a');
});

test('complete attributable post-restart evidence passes all Candidate M gates', async () => {
  const plan = await loadCandidateMPlan();
  const result = evaluateCandidateMEvidence(plan, validEvidence(plan));
  assert.equal(result.passed, true, result.failed.join(', '));
  assert.equal(result.claimBoundary.percentileEstablished, false);
});

test('hook-only storage and stale or workspace-scoped recall cannot pass memory', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  evidence.memory.seed.mainModelSemanticCall = false;
  evidence.memory.seed.hookOnly = true;
  evidence.memory.seed.scopeKind = 'workspace';
  evidence.memory.seed.workspaceScoped = true;
  evidence.memory.recall.selectedMemoryId = 'old-memory';
  evidence.memory.storageAudit.staleHigherRankedContradictionCount = 1;
  const result = evaluateCandidateMEvidence(plan, evidence);
  assert.deepEqual(result.failed.filter((id) => id.startsWith('memory-')), [
    'memory-semantic-store',
    'memory-durable-owner-scope',
    'memory-attributable-recall',
    'memory-authoritative-audit',
  ]);
});

test('workflow aliases, duplicate children, respawn, or fabricated usage fail closed', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  evidence.workflow.requests[0].requestedLimits.maxAgents = 3;
  evidence.workflow.requests[0].persistedLimits.maxAgents = 3;
  evidence.workflow.requests[1].delegationId = evidence.workflow.requests[0].delegationId;
  evidence.workflow.nativeSpawnCounts.replay = 1;
  evidence.workflow.capabilities.tokenUsage = false;
  evidence.workflow.usageClaims.tokens = 'measured';
  evidence.workflow.usage.tokens = 900;
  const result = evaluateCandidateMEvidence(plan, evidence);
  for (const id of ['workflow-unique-identities', 'workflow-exact-limits', 'workflow-no-native-respawn', 'workflow-tokens-honesty']) {
    assert(result.failed.includes(id), `${id} should fail`);
  }
});

test('direct action calls and hidden narrow controls are never upgraded to UI click evidence', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  evidence.ui.chrome.captures.find((capture) => capture.viewportWidthCssPx === 320).controls
    .find((control) => control.label === 'Picture in picture').visible = false;
  evidence.ui.actionClicks[0].activationKind = 'direct-tool';
  evidence.ui.actionClicks[0].directCall = true;
  evidence.ui.directBypassCalls.push({ kind: 'artifacts.write', usedAsClickEvidence: true });
  const result = evaluateCandidateMEvidence(plan, evidence);
  for (const id of ['ui-visible-named-controls', 'ui-real-outer-action-clicks', 'ui-no-direct-click-substitution']) {
    assert(result.failed.includes(id), `${id} should fail`);
  }
});

test('frontend recompilation cannot substitute for an in-place implementation action', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  evidence.ui.sources.refine.frontend.sha256 = 'f'.repeat(64);
  delete evidence.ui.sources.refine.implementation;
  evidence.ui.refine.actionReceipts = [];
  evidence.ui.refine.compileReceipts = [{ receiptId: 'compile-refine', durationMs: 800 }];
  evidence.ui.refine.renderReceipts = [{ receiptId: 'render-refine', durationMs: 70 }];
  const result = evaluateCandidateMEvidence(plan, evidence);
  for (const id of ['ui-targeted-refinement', 'ui-one-refine-binding']) {
    assert(result.failed.includes(id), `${id} should fail`);
  }
});

test('app-authored preview widths cannot substitute for exact outer chrome captures', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  const narrow = evidence.ui.chrome.captures.find((capture) => capture.viewportWidthCssPx === 320);
  narrow.surface = 'app-authored-preview';
  narrow.measurement = 'app-preview-css-px';
  const result = evaluateCandidateMEvidence(plan, evidence);
  assert(result.failed.includes('ui-visible-named-controls'));
});

test('cached redisplay fails on any write or changed binding', async () => {
  const plan = await loadCandidateMPlan();
  const evidence = validEvidence(plan);
  evidence.ui.cachedRedisplay.writeCalls = 1;
  evidence.ui.cachedRedisplay.componentId = '9'.repeat(64);
  const result = evaluateCandidateMEvidence(plan, evidence);
  assert(result.failed.includes('ui-cached-redisplay'));
});

function validEvidence(plan) {
  const sha = (character) => character.repeat(64);
  const screenshot = (ref, character) => ({ ref, sha256: sha(character) });
  const implementationBefore = 'export default function DirectionB() { return <main data-mobile="false">Dense direction B</main>; }';
  const implementationAfter = 'export default function DirectionB() { return <main data-mobile="true">Calm direction B</main>; }';
  const limits = {
    maxDepth: 0,
    maxTotalAgents: 3,
    maxConcurrency: 3,
    maxRetries: 0,
    allowedPermissions: [],
    allowedWorkspaceModes: ['shared'],
    allowedEffects: [],
  };
  const roles = plan.workflow.expected.requiredSpecialistRoles;
  const requests = roles.map((role, index) => ({
    role,
    idempotencyKey: `candidate-m-${role}`,
    delegationId: `delegation-${index + 1}`,
    replayDelegationId: `delegation-${index + 1}`,
    requestedLimits: structuredClone(limits),
    persistedLimits: structuredClone(limits),
    startedAt: `2026-08-03T12:00:00.${String(index * 20).padStart(3, '0')}Z`,
    completedAt: `2026-08-03T12:00:2${index}.000Z`,
    state: 'succeeded',
    replayReceipt: { receiptId: `replay-${index + 1}`, replayed: true },
  }));
  const controls = plan.ui.expected.namedControls.map((label) => ({ label, visible: true }));
  return {
    schemaVersion: '1.0.0',
    candidate: 'm',
    installation: {
      pluginVersion: '0.1.0+codex.candidate-m',
      pluginSourceSha256: sha('a'),
      pluginCacheSha256: sha('a'),
      restartedAt: '2026-08-03T11:50:00.000Z',
      processId: 1234,
      model: 'gpt-5.6-sol',
      reasoning: 'medium',
    },
    memory: {
      seed: {
        promptSha256: plan.memory.seed.sha256,
        workspacePath: 'C:/candidate-m/memory-seed',
        operation: 'memory.brain.remember',
        mainModelSemanticCall: true,
        hookOnly: false,
        deterministicFallbackUsed: false,
        accepted: true,
        finalized: true,
        receiptId: 'brain-store-receipt',
        memoryId: 'memory-amber-kestrel',
        scopeKind: 'agent',
        workspaceScoped: false,
        brainTiming: { classification: 'cold', durationMs: 5900 },
      },
      recall: {
        promptSha256: plan.memory.recall.sha256,
        workspacePath: 'C:/candidate-m/memory-recall',
        operation: 'memory.brain.recall',
        mainModelSemanticCall: true,
        receiptId: 'brain-recall-receipt',
        selectedMemoryId: 'memory-amber-kestrel',
        answer: 'Use the amber kestrel; inspect keyboard accessibility before load performance.',
        brainTiming: { classification: 'warm', durationMs: 2400 },
      },
      storageAudit: {
        recordCount: 1,
        memoryId: 'memory-amber-kestrel',
        workspaceScoped: false,
        staleHigherRankedContradictionCount: 0,
      },
    },
    workflow: {
      initialPromptSha256: plan.workflow.initial.sha256,
      replayPromptSha256: plan.workflow.replay.sha256,
      sourcePath: 'work/resumable-dossier.ts',
      initialSourceSha256: sha('b'),
      replaySourceSha256: sha('b'),
      initialWorkflowId: 'candidate-m-resumable-dossier-v1',
      replayWorkflowId: 'candidate-m-resumable-dossier-v1',
      initialExecutionId: 'execution-initial',
      replayExecutionId: 'execution-replay',
      requests,
      nativeSpawnCounts: { initial: 3, replay: 0 },
      childThreadIdsBeforeReplay: ['thread-a', 'thread-b', 'thread-c'],
      childThreadIdsAfterReplay: ['thread-a', 'thread-b', 'thread-c'],
      receiptTrees: requests.map((request, index) => ({
        rootDelegationId: request.delegationId,
        receiptId: `tree-${index + 1}`,
        totalNodes: 1,
        terminalNodes: 1,
      })),
      orphanDelegationIds: [],
      orphanThreadIds: [],
      invalidAliasProbe: { field: 'maxAgents', status: 'rejected', nativeSpawnDelta: 0 },
      capabilities: { tokenUsage: false, costUsage: false },
      usageClaims: { tokens: 'unsupported', cost: 'unsupported' },
      usage: { tokens: null, costUsd: null },
    },
    ui: {
      buildPromptSha256: plan.ui.build.sha256,
      refinePromptSha256: plan.ui.refine.sha256,
      restorePromptSha256: plan.ui.restore.sha256,
      routing: { marshalSelected: true, visualizationSelected: false },
      sources: {
        build: {
          orchestrator: { path: 'work/design-orchestrator.ts', sha256: sha('c') },
          backend: { path: 'outputs/design/backend.ts', sha256: sha('d') },
          frontend: { path: 'outputs/design/Workspace.tsx', sha256: sha('e') },
          implementation: {
            path: 'outputs/design/implementation.tsx',
            sha256: sha256(implementationBefore),
            content: implementationBefore,
          },
        },
        refine: {
          orchestrator: { path: 'work/design-orchestrator.ts', sha256: sha('c') },
          backend: { path: 'outputs/design/backend.ts', sha256: sha('d') },
          frontend: { path: 'outputs/design/Workspace.tsx', sha256: sha('e') },
          implementation: {
            path: 'outputs/design/implementation.tsx',
            sha256: sha256(implementationAfter),
            content: implementationAfter,
          },
        },
      },
      renderId: sha('1'),
      componentId: sha('2'),
      build: {
        compileReceipts: [{ receiptId: 'compile-build', durationMs: 900 }],
        renderReceipts: [{ receiptId: 'render-build', durationMs: 80 }],
        displayCount: 1,
      },
      refine: {
        compileReceipts: [],
        renderReceipts: [],
        displayCount: 1,
        renderId: sha('1'),
        componentId: sha('2'),
        sourceWrites: 1,
        unrelatedSourceWrites: 0,
        actionReceipts: [{
          actionId: 'refine-direction',
          tool: 'marshal_invoke_react_action',
          status: 'success',
          requestId: 'refine-direction-1',
          receiptId: 'action-refine-1',
          renderId: sha('1'),
          sourcePath: 'outputs/design/implementation.tsx',
          sourceBeforeSha256: sha256(implementationBefore),
          sourceAfterSha256: sha256(implementationAfter),
          nestedWriteReceiptIds: ['artifact-write-refinement-1'],
        }],
      },
      manifest: {
        presentationModes: ['inline', 'fullscreen', 'pip'],
        actions: [{ id: 'save-workspace' }, { id: 'load-workspace' }, { id: 'refine-direction' }],
        stateScope: 'project',
      },
      chrome: {
        rendererVersion: '1.2.0',
        captures: [
          {
            viewportWidthCssPx: 320,
            surface: 'outer-renderer-chrome',
            captureKind: 'outer-control-chrome',
            measurement: 'host-outer-container-css-px',
            controls: structuredClone(controls),
            screenshot: screenshot('chrome-320.png', '3'),
          },
          {
            viewportWidthCssPx: 1024,
            surface: 'outer-renderer-chrome',
            captureKind: 'outer-control-chrome',
            measurement: 'host-outer-container-css-px',
            controls: structuredClone(controls),
            screenshot: screenshot('chrome-1024.png', '4'),
          },
        ],
      },
      actionClicks: [
        {
          actionId: 'save-workspace', activationKind: 'human-pointer', surface: 'outer-renderer-chrome',
          method: 'marshal/ui/chrome-action-request', tool: 'marshal_invoke_react_action', status: 'success',
          directCall: false, requestId: 'chrome-save-1', receiptId: 'action-save-1', renderId: sha('1'),
          stateSha256: sha('5'), dispatchOverheadMs: 100, capture: screenshot('save-click.png', '6'),
        },
        {
          actionId: 'load-workspace', activationKind: 'automated-dom', surface: 'outer-renderer-chrome',
          method: 'marshal/ui/chrome-action-request', tool: 'marshal_invoke_react_action', status: 'success',
          directCall: false, requestId: 'chrome-reopen-1', receiptId: 'action-reopen-1', renderId: sha('1'),
          stateSha256: sha('5'), dispatchOverheadMs: 120, capture: screenshot('reopen-click.png', '7'),
        },
      ],
      stateProof: {
        savedStateSha256: sha('5'),
        interveningStateSha256: sha('8'),
        reopenedStateSha256: sha('5'),
        savedScreenshot: screenshot('saved-state.png', '9'),
        reopenedScreenshot: screenshot('reopened-state.png', 'a'),
      },
      displayModeClicks: [
        {
          requested: 'fullscreen', advertised: true, status: 'granted', actual: 'fullscreen',
          activationKind: 'human-pointer', surface: 'outer-renderer-chrome', requestId: 'mode-fullscreen-1',
          capture: screenshot('fullscreen.png', 'b'),
        },
        {
          requested: 'pip', advertised: false, status: 'unsupported', actual: 'inline',
          activationKind: 'not-activatable', surface: 'outer-renderer-chrome', requestId: null,
          statusText: 'unsupported: Picture in picture unavailable; the complete app remains inline.',
          capture: screenshot('pip-unsupported.png', 'c'),
        },
      ],
      directBypassCalls: [{ kind: 'artifacts.write', usedAsClickEvidence: false }],
      restartRestoration: {
        promptSha256: plan.ui.restore.sha256,
        restored: true,
        stateSha256: sha('5'),
        screenshot: screenshot('restart-restored.png', 'd'),
      },
      cachedRedisplay: {
        sourceWrites: 0,
        writeCalls: 0,
        compileCalls: 0,
        renderCalls: 0,
        renderId: sha('1'),
        componentId: sha('2'),
        durationMs: 9000,
      },
    },
  };
}
