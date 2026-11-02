import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_CANDIDATE_M_PLAN = resolve('docs/evals/candidate-m/acceptance-plan.json');
export const DEFAULT_V1_UI_CASES = resolve('docs/evals/v1/cases/ui.json');

export async function loadCandidateMPlan(path = DEFAULT_CANDIDATE_M_PLAN) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

export async function validateCandidateMPlan(
  plan,
  { uiCasesPath = DEFAULT_V1_UI_CASES } = {},
) {
  required(plan?.schemaVersion === '1.0.0', 'Candidate M plan schemaVersion must be 1.0.0.');
  required(plan?.candidate === 'm', 'Candidate M plan must identify candidate m.');
  const promptEntries = [
    plan.memory?.seed,
    plan.memory?.recall,
    plan.workflow?.initial,
    plan.workflow?.replay,
    plan.ui?.build,
    plan.ui?.refine,
    plan.ui?.restore,
  ];
  for (const entry of promptEntries) validatePrompt(entry);

  const uiCases = JSON.parse(await readFile(resolve(uiCasesPath), 'utf8'));
  const capstone = uiCases.cases?.find((item) => item.id === 'ui-design-studio-agent-orchestration-capstone');
  required(capstone, 'Frozen v1 Claude Design capstone is missing.');
  const frozen = Object.fromEntries(capstone.phases.map((phase) => [phase.id, phase]));
  for (const phase of ['build', 'refine', 'restore']) {
    required(
      plan.ui[phase].prompt === frozen[phase]?.prompt,
      `Candidate M ${phase} prompt differs from frozen v1 bytes.`,
    );
    required(
      plan.ui[phase].taskBoundary === frozen[phase]?.taskBoundary,
      `Candidate M ${phase} task boundary differs from frozen v1.`,
    );
  }

  const expected = plan.workflow?.expected;
  required(new Set(expected.allowedLimitKeys).size === expected.allowedLimitKeys.length, 'Allowed limit keys must be unique.');
  required(expected.requiredLimitKeys.every((key) => expected.allowedLimitKeys.includes(key)), 'Required limit keys must be allowed.');
  required(expected.forbiddenLimitAliases.every((key) => !expected.allowedLimitKeys.includes(key)), 'Forbidden aliases cannot be allowed.');
  required(plan.evidencePolicy?.singleRunEstablishesPercentile === false, 'A single live run must not establish percentile claims.');
  required(plan.evidencePolicy?.directRuntimeCallEstablishesUiClick === false, 'Direct calls must not establish UI click evidence.');
  required(plan.ui?.expected?.responsiveCaptureKind === 'outer-control-chrome', 'Responsive evidence must capture the outer control chrome.');
  required(plan.ui?.expected?.responsiveMeasurement === 'host-outer-container-css-px', 'Responsive evidence must use the host outer-container CSS width.');
  return {
    schemaVersion: plan.schemaVersion,
    candidate: plan.candidate,
    promptCount: promptEntries.length,
    promptDigests: Object.fromEntries(promptEntries.map((entry) => [entry.sha256, entry.prompt.length])),
  };
}

export function evaluateCandidateMEvidence(plan, evidence) {
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, passed: Boolean(passed), detail });
  check('evidence-schema', evidence?.schemaVersion === '1.0.0' && evidence?.candidate === 'm', 'schemaVersion=1.0.0 and candidate=m');
  evaluateInstallation(evidence?.installation, check);
  evaluateMemory(plan, evidence?.memory, check);
  evaluateWorkflow(plan, evidence?.workflow, check);
  evaluateUi(plan, evidence?.ui, check);
  return {
    schemaVersion: '1.0.0',
    candidate: 'm',
    passed: checks.every((item) => item.passed),
    checks,
    failed: checks.filter((item) => !item.passed).map((item) => item.id),
    claimBoundary: {
      percentileEstablished: false,
      uiClickRequiresOuterControlActivation: true,
      unsupportedTokenCostRemainsUnsupported: true,
    },
  };
}

function evaluateInstallation(value, check) {
  check('installation-version', nonEmpty(value?.pluginVersion), 'installed immutable plugin version recorded');
  check('installation-source-digest', digest(value?.pluginSourceSha256), 'plugin source digest recorded');
  check('installation-cache-digest', digest(value?.pluginCacheSha256), 'installed cache digest recorded');
  check('installation-digests-match', value?.pluginSourceSha256 === value?.pluginCacheSha256, 'source and installed cache digests match');
  check('installation-restart', nonEmpty(value?.restartedAt) && Number.isInteger(value?.processId) && value.processId > 0, 'restart timestamp and PID recorded');
  check('installation-model', nonEmpty(value?.model) && nonEmpty(value?.reasoning), 'model and reasoning recorded');
}

function evaluateMemory(plan, value, check) {
  const expected = plan.memory.expected;
  check('memory-prompt-digests', value?.seed?.promptSha256 === plan.memory.seed.sha256
    && value?.recall?.promptSha256 === plan.memory.recall.sha256, 'seed and recall prompts match the frozen plan');
  check('memory-cross-workspace', nonEmpty(value?.seed?.workspacePath)
    && nonEmpty(value?.recall?.workspacePath)
    && normalizePath(value.seed.workspacePath) !== normalizePath(value.recall.workspacePath), 'seed and recall use unrelated workspaces');
  check('memory-semantic-store', value?.seed?.operation === expected.rememberOperation
    && value.seed.mainModelSemanticCall === true
    && value.seed.hookOnly === false
    && value.seed.deterministicFallbackUsed === false, 'main model called semantic Brain remember');
  check('memory-store-finalized', value?.seed?.accepted === true
    && value.seed.finalized === true
    && nonEmpty(value.seed.receiptId)
    && nonEmpty(value.seed.memoryId), 'remember returned an attributable finalized durable receipt');
  check('memory-durable-owner-scope', expected.durableScopeKinds.includes(value?.seed?.scopeKind)
    && value.seed.workspaceScoped === false, 'memory is durable owner-scoped rather than workspace-only');
  check('memory-semantic-recall', value?.recall?.operation === expected.recallOperation
    && value.recall.mainModelSemanticCall === true
    && nonEmpty(value.recall.receiptId), 'fresh task called semantic Brain recall');
  const answer = String(value?.recall?.answer ?? '').toLowerCase();
  const accessibilityIndex = answer.indexOf('keyboard accessibility');
  const performanceIndex = answer.indexOf('load performance');
  check('memory-answer-exact-facts', expected.answerTerms.every((term) => answer.includes(term))
    && (performanceIndex < 0 || accessibilityIndex < performanceIndex), 'recall returns amber kestrel and accessibility before performance');
  check('memory-attributable-recall', value?.recall?.selectedMemoryId === value?.seed?.memoryId, 'recall selected the stored memory ID');
  check('memory-authoritative-audit', value?.storageAudit?.recordCount === 1
    && value.storageAudit.memoryId === value?.seed?.memoryId
    && value.storageAudit.workspaceScoped === false
    && value.storageAudit.staleHigherRankedContradictionCount === 0, 'authoritative store has one current owner-scoped record and no stale higher-ranked contradiction');
  for (const phase of ['seed', 'recall']) {
    const timing = value?.[phase]?.brainTiming;
    const maximum = timing?.classification === 'warm' ? expected.warmBrainTargetMs : expected.coldBrainTargetMs;
    check(`memory-${phase}-timing`, Number.isFinite(timing?.durationMs)
      && ['cold', 'warm'].includes(timing.classification)
      && timing.durationMs <= maximum, `${phase} Brain ${timing?.classification ?? 'unclassified'} duration <= ${maximum} ms`);
  }
}

function evaluateWorkflow(plan, value, check) {
  const expected = plan.workflow.expected;
  check('workflow-prompt-digests', value?.initialPromptSha256 === plan.workflow.initial.sha256
    && value?.replayPromptSha256 === plan.workflow.replay.sha256, 'initial and replay prompts match the frozen plan');
  check('workflow-editable-source', digest(value?.initialSourceSha256)
    && value.initialSourceSha256 === value?.replaySourceSha256
    && nonEmpty(value?.sourcePath), 'replay uses unchanged editable source');
  check('workflow-stable-identity', nonEmpty(value?.initialWorkflowId)
    && value.initialWorkflowId === value?.replayWorkflowId
    && value.initialExecutionId !== value?.replayExecutionId, 'distinct runtime executions use one stable workflow ID');
  const requests = Array.isArray(value?.requests) ? value.requests : [];
  const roles = requests.map((request) => request.role).sort();
  check('workflow-useful-specialists', requests.length === expected.minimumSpecialists
    && sameJson(roles, [...expected.requiredSpecialistRoles].sort()), 'exactly the three useful specialist roles were launched');
  const ids = requests.map((request) => request.delegationId);
  const keys = requests.map((request) => request.idempotencyKey);
  check('workflow-unique-identities', ids.every(nonEmpty) && keys.every(nonEmpty)
    && new Set(ids).size === requests.length
    && new Set(keys).size === requests.length, 'delegation IDs and idempotency keys are unique');
  const baselineLimits = requests[0]?.requestedLimits;
  const exactLimits = requests.length > 0 && requests.every((request) => {
    const keysInRequest = Object.keys(request.requestedLimits ?? {});
    return expected.requiredLimitKeys.every((key) => keysInRequest.includes(key))
      && keysInRequest.every((key) => expected.allowedLimitKeys.includes(key))
      && expected.forbiddenLimitAliases.every((key) => !keysInRequest.includes(key))
      && sameJson(request.requestedLimits, baselineLimits)
      && sameJson(request.requestedLimits, request.persistedLimits)
      && validLimits(request.requestedLimits, requests.length);
  });
  check('workflow-exact-limits', exactLimits, 'closed-schema requested limits exactly match durable handle limits');
  check('workflow-replayed-handles', requests.length > 0 && requests.every((request) => request.replayDelegationId === request.delegationId
    && request.replayReceipt?.replayed === true
    && nonEmpty(request.replayReceipt?.receiptId)), 'replayed spawns returned the original handles with replay receipts');
  check('workflow-no-native-respawn', value?.nativeSpawnCounts?.initial === requests.length
    && value.nativeSpawnCounts.replay === 0
    && sameJson(sorted(value?.childThreadIdsBeforeReplay), sorted(value?.childThreadIdsAfterReplay)), 'replay created no new native child task');
  const starts = requests.map((request) => Date.parse(request.startedAt));
  const ends = requests.map((request) => Date.parse(request.completedAt));
  check('workflow-concurrent-terminal', starts.every(Number.isFinite)
    && ends.every(Number.isFinite)
    && Math.max(...starts) - Math.min(...starts) <= 1000
    && requests.every((request, index) => request.state === expected.terminalState && ends[index] >= starts[index]), 'specialists started within one second and all succeeded');
  const trees = Array.isArray(value?.receiptTrees) ? value.receiptTrees : [];
  const treeRoots = new Set(trees.map((tree) => tree.rootDelegationId));
  check('workflow-complete-receipt-forest', ids.length > 0 && ids.every((id) => treeRoots.has(id))
    && trees.every((tree) => nonEmpty(tree.receiptId) && tree.terminalNodes === tree.totalNodes), 'receipt forest covers every terminal root and child');
  check('workflow-zero-orphans', Array.isArray(value?.orphanDelegationIds) && value.orphanDelegationIds.length === 0
    && Array.isArray(value?.orphanThreadIds) && value.orphanThreadIds.length === 0, 'Marshal and Codex inventories contain no running orphan');
  check('workflow-alias-probe', value?.invalidAliasProbe?.field === 'maxAgents'
    && value.invalidAliasProbe.status === 'rejected'
    && value.invalidAliasProbe.nativeSpawnDelta === 0, 'unknown limit alias was rejected before native spawn');
  evaluateUsageBoundary('tokens', value?.capabilities?.tokenUsage, value?.usageClaims?.tokens, value?.usage?.tokens, check);
  evaluateUsageBoundary('cost', value?.capabilities?.costUsage, value?.usageClaims?.cost, value?.usage?.costUsd, check);
}

function evaluateUsageBoundary(kind, supported, claim, measured, check) {
  const honest = supported === true
    ? claim === 'measured' && Number.isFinite(measured) && measured >= 0
    : supported === false && claim === 'unsupported' && (measured === null || measured === undefined);
  check(`workflow-${kind}-honesty`, honest, supported === true
    ? `${kind} is advertised and measured`
    : `${kind} is unadvertised and remains explicitly unsupported`);
}

function evaluateUi(plan, value, check) {
  const expected = plan.ui.expected;
  check('ui-prompt-digests', value?.buildPromptSha256 === plan.ui.build.sha256
    && value?.refinePromptSha256 === plan.ui.refine.sha256
    && value?.restorePromptSha256 === plan.ui.restore.sha256, 'build/refine/restore prompts match frozen v1');
  check('ui-autonomous-routing', value?.routing?.marshalSelected === true
    && value.routing.visualizationSelected === false, 'fresh task selected Marshal without generic visualization');
  const buildSources = value?.sources?.build ?? {};
  const refineSources = value?.sources?.refine ?? {};
  check('ui-separated-editable-source', ['orchestrator', 'backend', 'frontend'].every((name) => nonEmpty(buildSources[name]?.path) && digest(buildSources[name]?.sha256)), 'orchestrator, backend, and frontend source are separate and hashed');
  const buildImplementation = buildSources.implementation;
  const refineImplementation = refineSources.implementation;
  const refineActionReceipts = Array.isArray(value?.refine?.actionReceipts) ? value.refine.actionReceipts : [];
  const refineAction = refineActionReceipts.find((receipt) => receipt?.sourcePath === refineImplementation?.path);
  const shellSourceNames = ['orchestrator', 'backend', 'frontend'];
  check('ui-targeted-refinement', shellSourceNames.every((name) => buildSources[name]?.path === refineSources[name]?.path
      && buildSources[name]?.sha256 === refineSources[name]?.sha256)
    && validSourceSnapshot(buildImplementation)
    && validSourceSnapshot(refineImplementation)
    && buildImplementation.path === refineImplementation.path
    && buildImplementation.sha256 !== refineImplementation.sha256
    && buildImplementation.content !== refineImplementation.content
    && refineAction?.status === 'success'
    && nonEmpty(refineAction?.actionId)
    && (value?.manifest?.actions ?? []).some((action) => action.id === refineAction.actionId)
    && refineAction?.tool === expected.actionTool
    && nonEmpty(refineAction?.requestId)
    && nonEmpty(refineAction?.receiptId)
    && refineAction?.renderId === value?.renderId
    && refineAction?.sourceBeforeSha256 === buildImplementation.sha256
    && refineAction?.sourceAfterSha256 === refineImplementation.sha256
    && Array.isArray(refineAction?.nestedWriteReceiptIds)
    && refineAction.nestedWriteReceiptIds.length > 0
    && refineAction.nestedWriteReceiptIds.every(nonEmpty), 'refinement action changes authoritative implementation content while leaving the app shell intact');
  check('ui-one-build-binding', value?.build?.compileReceipts?.length === 1
    && value.build.renderReceipts?.length === 1
    && value.build.displayCount === 1
    && value.build.compileReceipts.every(receiptWithDuration)
    && value.build.renderReceipts.every(receiptWithDuration)
    && digest(value?.renderId)
    && digest(value?.componentId), 'build has one compile, one render, one display, and stable IDs');
  check('ui-one-refine-binding', value?.refine?.compileReceipts?.length === 0
    && value.refine.renderReceipts?.length === 0
    && value.refine.displayCount === 1
    && value.refine.renderId === value?.renderId
    && value.refine.componentId === value?.componentId
    && Number.isInteger(value.refine.sourceWrites)
    && value.refine.sourceWrites > 0
    && value.refine.unrelatedSourceWrites === 0, 'refinement redisplays the same binding after only the targeted implementation-source action');
  const modes = sorted(value?.manifest?.presentationModes);
  const actionIds = sorted((value?.manifest?.actions ?? []).map((action) => action.id));
  check('ui-manifest-contract', sameJson(modes, sorted(expected.presentationModes))
    && expected.actionIds.every((id) => actionIds.includes(id))
    && value?.manifest?.stateScope === 'project', 'manifest declares all modes, Save/Reopen actions, and project state');
  check('ui-renderer-version', value?.chrome?.rendererVersion === expected.rendererVersion, `renderer ${expected.rendererVersion} recorded`);
  const chromeCaptures = Array.isArray(value?.chrome?.captures) ? value.chrome.captures : [];
  const widths = new Map(chromeCaptures.map((capture) => [capture.viewportWidthCssPx, capture]));
  check('ui-visible-named-controls', expected.requiredWidths.every((width) => {
    const capture = widths.get(width);
    const visible = new Set((capture?.controls ?? []).filter((control) => control.visible === true).map((control) => control.label));
    return capture?.surface === expected.outerControlSurface
      && capture?.captureKind === expected.responsiveCaptureKind
      && capture?.measurement === expected.responsiveMeasurement
      && expected.namedControls.every((label) => visible.has(label))
      && evidenceReference(capture?.screenshot);
  }), 'all named outer controls are visible in host outer-chrome captures at exact 320px and 1024px CSS widths');
  const clicks = Array.isArray(value?.actionClicks) ? value.actionClicks : [];
  const save = clicks.find((click) => click.actionId === 'save-workspace');
  const reopen = clicks.find((click) => click.actionId === 'load-workspace');
  check('ui-real-outer-action-clicks', [save, reopen].every((click) => validOuterClick(click, expected))
    && save?.receiptId !== reopen?.receiptId
    && save?.renderId === value?.renderId
    && reopen?.renderId === value?.renderId, 'Save and Reopen came from distinct real outer-control activations and action receipts');
  check('ui-state-roundtrip', digest(value?.stateProof?.savedStateSha256)
    && value.stateProof.savedStateSha256 === value.stateProof.reopenedStateSha256
    && value.stateProof.interveningStateSha256 !== value.stateProof.savedStateSha256
    && evidenceReference(value.stateProof.savedScreenshot)
    && evidenceReference(value.stateProof.reopenedScreenshot), 'reopen restores the exact saved state after an intervening change');
  const modeResults = new Map((value?.displayModeClicks ?? []).map((entry) => [entry.requested, entry]));
  check('ui-display-mode-clicks', ['fullscreen', 'pip'].every((mode) => validModeClick(modeResults.get(mode), mode, expected)), 'Fullscreen and PiP outer controls have typed truthful host outcomes');
  check('ui-no-direct-click-substitution', (value?.directBypassCalls ?? []).every((entry) => entry.usedAsClickEvidence === false), 'direct tool or artifact calls are not counted as UI clicks');
  check('ui-restart-restoration', value?.restartRestoration?.promptSha256 === plan.ui.restore.sha256
    && value.restartRestoration.restored === true
    && value.restartRestoration.stateSha256 === value?.stateProof?.savedStateSha256
    && evidenceReference(value.restartRestoration.screenshot), 'post-restart task restored saved state with pixel evidence');
  check('ui-cached-redisplay', value?.cachedRedisplay?.sourceWrites === 0
    && value.cachedRedisplay.writeCalls === 0
    && value.cachedRedisplay.compileCalls === 0
    && value.cachedRedisplay.renderCalls === 0
    && value.cachedRedisplay.renderId === value?.renderId
    && value.cachedRedisplay.componentId === value?.componentId
    && value.cachedRedisplay.durationMs <= expected.singleCachedDisplayTargetMs, 'cached redisplay reused the exact binding without write/compile/render work');
  check('ui-cold-compile-timing', value?.build?.compileReceipts?.[0]?.durationMs <= expected.singleColdCompileTargetMs, `single cold compile <= ${expected.singleColdCompileTargetMs} ms`);
  check('ui-action-overhead-timing', [save, reopen].every((click) => Number.isFinite(click?.dispatchOverheadMs)
    && click.dispatchOverheadMs <= expected.singleActionDispatchOverheadTargetMs), `each action dispatch overhead <= ${expected.singleActionDispatchOverheadTargetMs} ms`);
}

function validOuterClick(click, expected) {
  return click
    && expected.acceptedClickKinds.includes(click.activationKind)
    && click.surface === expected.outerControlSurface
    && click.method === expected.chromeActionMethod
    && click.tool === expected.actionTool
    && click.status === 'success'
    && click.directCall === false
    && nonEmpty(click.requestId)
    && nonEmpty(click.receiptId)
    && digest(click.stateSha256)
    && evidenceReference(click.capture);
}

function validModeClick(click, requested, expected) {
  if (!click
    || click.surface !== expected.outerControlSurface
    || click.requested !== requested
    || !evidenceReference(click.capture)) return false;
  if (click.advertised === true) return expected.acceptedClickKinds.includes(click.activationKind)
    && nonEmpty(click.requestId)
    && click.status === 'granted'
    && click.actual === requested;
  return click.advertised === false
    && click.activationKind === expected.unavailableModeActivationKind
    && (click.requestId === null || click.requestId === undefined)
    && ['unsupported', 'denied', 'fallback'].includes(click.status)
    && click.actual !== requested
    && nonEmpty(click.statusText);
}

function validatePrompt(entry) {
  required(nonEmpty(entry?.prompt), 'Every Candidate M phase needs prompt text.');
  required(digest(entry?.sha256), 'Every Candidate M phase needs an exact SHA-256 digest.');
  required(sha256(entry.prompt) === entry.sha256, `Prompt digest mismatch: ${entry.prompt.slice(0, 48)}…`);
}

function receiptWithDuration(value) {
  return nonEmpty(value?.receiptId) && Number.isFinite(value?.durationMs) && value.durationMs >= 0;
}

function validSourceSnapshot(value) {
  return nonEmpty(value?.path)
    && nonEmpty(value?.content)
    && digest(value?.sha256)
    && sha256(value.content) === value.sha256;
}

function validLimits(value, totalAgents) {
  const integer = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0;
  const boundedNumber = (candidate) => candidate === undefined
    || (Number.isFinite(candidate) && candidate >= 0);
  return value
    && integer(value.maxDepth)
    && integer(value.maxTotalAgents)
    && value.maxTotalAgents >= totalAgents
    && integer(value.maxConcurrency)
    && value.maxConcurrency > 0
    && value.maxConcurrency <= value.maxTotalAgents
    && integer(value.maxRetries)
    && boundedNumber(value.maxTokens)
    && boundedNumber(value.maxCostUsd)
    && Array.isArray(value.allowedPermissions)
    && value.allowedPermissions.every(nonEmpty)
    && Array.isArray(value.allowedWorkspaceModes)
    && value.allowedWorkspaceModes.length > 0
    && new Set(value.allowedWorkspaceModes).size === value.allowedWorkspaceModes.length
    && value.allowedWorkspaceModes.every((mode) => mode === 'shared' || mode === 'isolated')
    && Array.isArray(value.allowedEffects)
    && value.allowedEffects.every(nonEmpty);
}

function evidenceReference(value) {
  return nonEmpty(value?.ref) && digest(value?.sha256);
}

function sorted(value) {
  return Array.isArray(value) ? [...value].sort() : [];
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').toLowerCase();
}

function sameJson(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
