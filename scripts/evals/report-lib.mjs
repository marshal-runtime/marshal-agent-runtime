import { assert } from './core.mjs';
import { applyHumanGrades } from './evidence.mjs';

export function buildEvaluationReport({ corpus, plan, records, humanGrades = new Map() }) {
  const unique = new Map();
  for (const record of records) {
    assert(!unique.has(record.attemptKey), `Duplicate evidence attempt: ${record.attemptKey}`);
    unique.set(record.attemptKey, record);
  }
  const gradedRecords = records.map((record) => {
    const item = corpus.cases.find((candidate) => candidate.id === record.caseId);
    assert(item, `Unknown evidence case: ${record.caseId}`);
    return applyHumanGrades(record, humanGrades, item);
  });
  const gradedByKey = new Map(gradedRecords.map((record) => [record.attemptKey, record]));
  const controlTreatmentId = corpus.manifest.headlineComparison.controlTreatmentId;
  const marshalTreatmentId = corpus.manifest.headlineComparison.marshalTreatmentId;
  const missingAttempts = plan.attempts
    .filter((attempt) => !gradedByKey.has(attempt.attemptKey))
    .map((attempt) => attempt.attemptKey);
  const unexpectedAttempts = gradedRecords
    .filter((record) => !plan.attempts.some((attempt) => attempt.attemptKey === record.attemptKey))
    .map((record) => record.attemptKey);
  const pendingHumanGrades = gradedRecords.flatMap((record) =>
    record.evidence.assertions
      .filter((assertion) => assertion.status === 'pending')
      .map((assertion) => assertion.blindId),
  );
  const excludedAttempts = gradedRecords
    .filter((record) => record.outcome.excluded)
    .map((record) => record.attemptKey);
  const evidenceClasses = [...new Set(gradedRecords.map((record) => record.evidenceClass))];
  const pairs = [];
  for (const pair of groupPlanPairs(plan)) {
    const baselinePlan = pair.find((attempt) => attempt.treatmentId === controlTreatmentId);
    const marshalPlan = pair.find((attempt) => attempt.treatmentId === marshalTreatmentId);
    const baseline = baselinePlan ? gradedByKey.get(baselinePlan.attemptKey) : undefined;
    const marshal = marshalPlan ? gradedByKey.get(marshalPlan.attemptKey) : undefined;
    if (!baseline || !marshal) continue;
    if (baseline.metrics.weightedTaskSuccess === null || marshal.metrics.weightedTaskSuccess === null) continue;
    pairs.push({
      pairId: baseline.pairId,
      caseId: baseline.caseId,
      family: baseline.family,
      repetition: baseline.repetition,
      baseline: baseline.metrics.weightedTaskSuccess,
      marshal: marshal.metrics.weightedTaskSuccess,
      difference: marshal.metrics.weightedTaskSuccess - baseline.metrics.weightedTaskSuccess,
    });
  }
  const allStats = pairedStats(pairs.map((pair) => pair.difference));
  const controlPairs = pairs.filter((pair) => pair.family === 'control');
  const targetedPairs = pairs.filter((pair) => pair.family !== 'control');
  const controlStats = pairedStats(controlPairs.map((pair) => pair.difference));
  const targetedStats = pairedStats(targetedPairs.map((pair) => pair.difference));
  const familyStats = Object.fromEntries(
    [...new Set(pairs.map((pair) => pair.family))].sort().map((family) => [
      family,
      pairedStats(pairs.filter((pair) => pair.family === family).map((pair) => pair.difference)),
    ]),
  );
  const targetedFamilyStats = Object.fromEntries(
    Object.entries(familyStats).filter(([family]) => family !== 'control'),
  );
  const complete = missingAttempts.length === 0
    && unexpectedAttempts.length === 0
    && pendingHumanGrades.length === 0
    && excludedAttempts.length === 0
    && gradedRecords.length === plan.expectedAttempts;
  const liveMatchedEvidence = evidenceClasses.length === 1 && evidenceClasses[0] === 'live';
  const repositoryPinned = gradedRecords.every((record) => record.environment.repositoryDirty === false);
  const configurationConsistent = gradedRecords.every((record) =>
    record.configurationDigest === plan.configurationDigest
    && record.environment.corpusDigest === plan.corpusDigest,
  );
  const requiredReleaseAttestations = [
    'liveAuthorizationDigest',
    'networkEnforcementDigest',
    'processConfinementProfileDigest',
    'processConfinementMeasurementDigest',
    'processConfinementReceiptBundleDigest',
    'processConfinementCleanupDigest',
    'objectiveOracleDigest',
  ];
  const persistedConfinementVerifierAvailable = false;
  const releaseAttestationsComplete = persistedConfinementVerifierAvailable && gradedRecords.every((record) => {
    const attestations = record.environment.releaseAttestations ?? {};
    const lease = record.environment.confinementLease;
    return requiredReleaseAttestations.every((field) => /^[a-f0-9]{64}$/.test(attestations[field] ?? ''))
      && lease?.status === 'cleaned'
      && lease.providerConfigured === true
      && lease.releaseEligible === true
      && Array.isArray(lease.blockers)
      && lease.blockers.length === 0
      && lease.attestationMeasurement === attestations.processConfinementMeasurementDigest
      && lease.receiptBundleDigest === attestations.processConfinementReceiptBundleDigest
      && lease.cleanupReceiptDigest === attestations.processConfinementCleanupDigest
      && lease.profileSha256 === attestations.processConfinementProfileDigest
      && /^[a-f0-9]{64}$/.test(lease.providerSha256 ?? '')
      && /^[a-f0-9]{64}$/.test(lease.providerIdentityDigest ?? '')
      && /^[a-f0-9]{64}$/.test(lease.providerApprovalDigest ?? '')
      && /^[a-f0-9]{64}$/.test(lease.profileSemanticsSha256 ?? '')
      && /^[a-f0-9]{64}$/.test(lease.executionPlanDigest ?? '')
      && ['codex-process', 'marshal-plugin-children', 'workspace-command-children', 'objective-oracle']
        .every((role) => lease.requiredRoles?.includes(role) && lease.observedRoles?.includes(role))
      && Number.isInteger(lease.commandReceiptCount)
      && lease.commandReceiptCount >= lease.requiredRoles.length
      && lease.attemptKey === record.attemptKey
      && lease.configurationDigest === record.configurationDigest;
  });
  const costCaptured = gradedRecords.every((record) => typeof record.metrics.estimatedCostUsd === 'number');
  const objectiveEvidenceComplete = gradedRecords.every((record) =>
    record.evidence.assertions.every((assertion) =>
      assertion.kind === 'human-rubric'
      || (assertion.status === 'graded'
        && !['objective-missing-signal', 'objective-unsupported-signal', 'objective-attempt-status'].includes(assertion.grader))),
  );
  const uiEvidenceComplete = gradedRecords.every((record) =>
    record.family !== 'ui'
    || (record.evidence.uiEvidence.length > 0
      && record.evidence.uiEvidence.every((entry) => entry.redacted === true && entry.blindSafe === true)),
  );
  const artifactPublicationSafe = gradedRecords.every((record) =>
    record.evidence.artifacts.every((entry) => entry.redacted === true),
  );
  const gates = {
    publishAllAttempts: {
      passed: missingAttempts.length === 0 && unexpectedAttempts.length === 0,
      expected: plan.expectedAttempts,
      observed: gradedRecords.length,
    },
    minimumRepetitions: {
      passed: plan.repetitions >= corpus.manifest.runPolicy.minimumRepetitions,
      required: corpus.manifest.runPolicy.minimumRepetitions,
      observed: plan.repetitions,
    },
    matchedConfiguration: {
      passed: configurationConsistent,
      configurationDigest: plan.configurationDigest,
    },
    cleanRepositorySnapshot: {
      passed: repositoryPinned,
      rule: 'every live attempt must use the declared clean repository commit',
    },
    releaseAttestations: {
      passed: releaseAttestationsComplete,
      rule: 'release requires a runner-derived frozen execution plan plus a persisted cryptographically verified confinement transcript; this scaffold intentionally provides neither authority',
    },
    costCaptured: {
      passed: costCaptured,
      rule: 'every attempt records a USD estimate from the pinned pricing snapshot',
    },
    objectiveEvidenceComplete: {
      passed: objectiveEvidenceComplete,
      rule: 'every non-human assertion is backed by a deterministic oracle observation',
    },
    uiEvidenceComplete: {
      passed: uiEvidenceComplete,
      rule: 'every UI-family attempt includes captured host evidence',
    },
    artifactPublicationSafe: {
      passed: artifactPublicationSafe,
      rule: 'captured generated artifacts are redacted before publication',
    },
    statisticallyPositivePairedOverall: {
      passed: statisticallyPositivePaired(allStats),
      rule: 'two-sided 95% paired t confidence interval lower bound must be greater than zero',
      ...allStats,
    },
    targetedFamiliesImprove: {
      passed: Object.keys(targetedFamilyStats).length > 0
        && Object.values(targetedFamilyStats).every((stats) => typeof stats.mean === 'number' && stats.mean > 0),
      rule: 'mean paired improvement in every targeted non-control family must be greater than zero',
      ...targetedStats,
      families: targetedFamilyStats,
    },
    controlRegressionAtMostFivePoints: {
      passed: controlRegressionWithinLimit(
        controlStats,
        corpus.manifest.releaseClaimPolicy.controlRegressionLimitPercentagePoints,
      ),
      rule: 'mean paired ordinary-control regression must be no greater than 5 percentage points',
      limit: -(corpus.manifest.releaseClaimPolicy.controlRegressionLimitPercentagePoints / 100),
      ...controlStats,
    },
  };
  const releaseEligible = liveMatchedEvidence
    && plan.fullCorpus
    && complete
    && configurationConsistent
    && repositoryPinned
    && releaseAttestationsComplete
    && costCaptured
    && objectiveEvidenceComplete
    && uiEvidenceComplete
    && artifactPublicationSafe;
  for (const name of [
    'statisticallyPositivePairedOverall',
    'targetedFamiliesImprove',
    'controlRegressionAtMostFivePoints',
  ]) {
    gates[name].evaluated = releaseEligible;
  }
  const releasePassed = releaseEligible && Object.values(gates).every((gate) => gate.passed);
  const prerequisiteBlockers = releasePrerequisiteBlockers({
    liveMatchedEvidence,
    fullCorpus: plan.fullCorpus,
    complete,
    missingAttempts,
    unexpectedAttempts,
    pendingHumanGrades,
    excludedAttempts,
    repositoryPinned,
    releaseAttestationsComplete,
    costCaptured,
    objectiveEvidenceComplete,
    uiEvidenceComplete,
    artifactPublicationSafe,
    evidenceClasses,
  });
  const failedOutcomeGates = releaseEligible
    ? Object.entries(gates)
      .filter(([, gate]) => !gate.passed)
      .map(([name]) => name)
    : [];
  return {
    schemaVersion: '1.0.0',
    runId: plan.runId,
    generatedAt: latestEvidenceCompletion(gradedRecords),
    evidenceClassification: evidenceClasses,
    liveMatchedEvidence,
    fullCorpus: plan.fullCorpus,
    complete,
    releaseClaim: {
      eligible: releaseEligible,
      passed: releasePassed,
      statement: releasePassed
        ? 'The predeclared matched-evaluation release gates passed.'
        : releaseEligible
          ? 'The live matched run completed, but one or more predeclared release gates failed.'
          : 'No release claim is permitted from this evidence.',
    },
    releaseReadiness: {
      prerequisiteBlockers,
      exclusionReasons: summarizeExclusionReasons(gradedRecords),
      statisticalGatesEvaluated: releaseEligible,
      failedOutcomeGates,
    },
    completeness: {
      expectedAttempts: plan.expectedAttempts,
      observedAttempts: gradedRecords.length,
      missingAttempts,
      unexpectedAttempts,
      pendingHumanGrades,
      excludedAttempts,
    },
    gates,
    paired: {
      overall: allStats,
      control: controlStats,
      targeted: targetedStats,
      byFamily: familyStats,
    },
    treatments: {
      [controlTreatmentId]: summarizeArm(gradedRecords.filter((record) => record.treatmentId === controlTreatmentId)),
      [marshalTreatmentId]: summarizeArm(gradedRecords.filter((record) => record.treatmentId === marshalTreatmentId)),
    },
    attempts: gradedRecords.map((record) => ({
      attemptKey: record.attemptKey,
      caseId: record.caseId,
      family: record.family,
      treatmentId: record.treatmentId,
      repetition: record.repetition,
      orderIndex: record.orderIndex,
      status: record.outcome.status,
      excluded: record.outcome.excluded,
      weightedTaskSuccess: record.metrics.weightedTaskSuccess,
      wallTimeMs: record.metrics.wallTimeMs,
      tokens: record.metrics.tokens,
      estimatedCostUsd: record.metrics.estimatedCostUsd,
      retries: record.metrics.retries,
    })),
  };
}

function latestEvidenceCompletion(records) {
  return records.reduce((latest, record) => {
    const completedAt = record.completedAt ?? null;
    return completedAt !== null && (latest === null || completedAt > latest) ? completedAt : latest;
  }, null);
}

export function renderMarkdownReport(report) {
  const fixture = !report.liveMatchedEvidence;
  const unavailable = report.evidenceClassification.includes('unavailable');
  const lines = [
    fixture
      ? unavailable
        ? '# Marshal evaluation report — UNAVAILABLE / NON-LIVE EVIDENCE'
        : '# Marshal evaluation report — NON-LIVE / FIXTURE EVIDENCE'
      : '# Marshal matched evaluation report',
    '',
    fixture
      ? unavailable
        ? '**One or more attempts were unavailable or skipped before a supported live boundary; no product claim is permitted.**'
        : '**No stock Codex baseline was run by this evidence. Fixture and dry-run output cannot support a product claim.**'
      : report.releaseClaim.passed
        ? '**The predeclared live matched-evaluation gates passed.**'
        : '**No release claim: the run is incomplete or a predeclared gate failed.**',
    '',
    `Run: \`${report.runId}\``,
    `Attempts: ${report.completeness.observedAttempts}/${report.completeness.expectedAttempts}`,
    `Full frozen corpus: ${yesNo(report.fullCorpus)}`,
    `Pending blind human grades: ${report.completeness.pendingHumanGrades.length}`,
    `Release prerequisite blockers: ${report.releaseReadiness.prerequisiteBlockers.length}`,
    '',
    '## Release blockers',
    '',
    ...(report.releaseReadiness.prerequisiteBlockers.length > 0
      ? report.releaseReadiness.prerequisiteBlockers.map((blocker) =>
        `- ${blocker.code}: ${blocker.message}`)
      : ['- None. Statistical outcome gates were evaluated.']),
    ...Object.entries(report.releaseReadiness.exclusionReasons).map(([reason, count]) =>
      `- Excluded attempts (${count}): ${reason}`),
    '',
    '## Predeclared gates',
    '',
    '| Gate | Result | Evidence |',
    '| --- | --- | --- |',
    `| Publish all attempts | ${passFail(report.gates.publishAllAttempts.passed)} | ${report.gates.publishAllAttempts.observed}/${report.gates.publishAllAttempts.expected} |`,
    `| Minimum repetitions | ${passFail(report.gates.minimumRepetitions.passed)} | ${report.gates.minimumRepetitions.observed}, minimum ${report.gates.minimumRepetitions.required} |`,
    `| Fixed matched configuration | ${passFail(report.gates.matchedConfiguration.passed)} | \`${report.gates.matchedConfiguration.configurationDigest}\` |`,
    `| Clean repository snapshot | ${passFail(report.gates.cleanRepositorySnapshot.passed)} | fixed declared commit |`,
    `| Hash-pinned live authorization and confinement | ${passFail(report.gates.releaseAttestations.passed)} | authorization, network, cleaned lease, measurement, command/cleanup receipts, oracle |`,
    `| Cost captured | ${passFail(report.gates.costCaptured.passed)} | pinned USD pricing snapshot |`,
    `| Objective evidence complete | ${passFail(report.gates.objectiveEvidenceComplete.passed)} | deterministic oracle |`,
    `| UI evidence complete | ${passFail(report.gates.uiEvidenceComplete.passed)} | required for every UI-family attempt |`,
    `| Artifact publication safety | ${passFail(report.gates.artifactPublicationSafe.passed)} | redacted captured artifacts |`,
    `| Statistically positive paired overall | ${gateResult(report.gates.statisticallyPositivePairedOverall)} | mean ${percent(report.gates.statisticallyPositivePairedOverall.mean)}, 95% CI ${interval(report.gates.statisticallyPositivePairedOverall.confidence95)} |`,
    `| Targeted families improve | ${gateResult(report.gates.targetedFamiliesImprove)} | mean ${percent(report.gates.targetedFamiliesImprove.mean)} |`,
    `| Ordinary-control regression ≤ 5pp | ${gateResult(report.gates.controlRegressionAtMostFivePoints)} | mean ${percent(report.gates.controlRegressionAtMostFivePoints.mean)} |`,
    '',
    '## Paired effects by family',
    '',
    '| Family | Pairs | Mean difference | 95% CI |',
    '| --- | ---: | ---: | --- |',
    ...Object.entries(report.paired.byFamily).map(([family, stats]) =>
      `| ${family} | ${stats.count} | ${percent(stats.mean)} | ${interval(stats.confidence95)} |`,
    ),
    '',
    '## Evidence completeness',
    '',
    `- Missing attempts: ${report.completeness.missingAttempts.length}`,
    `- Unexpected attempts: ${report.completeness.unexpectedAttempts.length}`,
    `- Excluded attempts: ${report.completeness.excludedAttempts.length}`,
    `- Pending human grades: ${report.completeness.pendingHumanGrades.length}`,
    '',
    'Every observed attempt remains listed in `report.json` and `evidence.jsonl`; no best-of-N selection is applied.',
    '',
  ];
  return lines.join('\n');
}

function releasePrerequisiteBlockers(state) {
  const blockers = [];
  if (!state.liveMatchedEvidence) blockers.push({
    code: 'LIVE_MATCHED_EVIDENCE_REQUIRED',
    message: `Evidence classes are ${state.evidenceClasses.join(', ') || 'empty'}; every attempt must be live.`,
  });
  if (!state.fullCorpus) blockers.push({
    code: 'FULL_CORPUS_REQUIRED',
    message: 'The plan does not include every frozen corpus case.',
  });
  if (!state.complete) blockers.push({
    code: 'COMPLETE_ATTEMPT_SET_REQUIRED',
    message: `${state.missingAttempts.length} missing, ${state.unexpectedAttempts.length} unexpected, ${state.excludedAttempts.length} excluded attempts, and ${state.pendingHumanGrades.length} pending human grades.`,
  });
  if (!state.repositoryPinned) blockers.push({
    code: 'CLEAN_REPOSITORY_REQUIRED',
    message: 'At least one attempt records a dirty repository snapshot.',
  });
  if (!state.releaseAttestationsComplete) blockers.push({
    code: 'RELEASE_ATTESTATIONS_REQUIRED',
    message: 'Every attempt must bind operator authorization, network enforcement, a release-eligible cleaned confinement lease, its profile/measurement/command/cleanup receipt digests, and the objective oracle digest.',
  });
  if (!state.costCaptured) blockers.push({
    code: 'PINNED_COST_REQUIRED',
    message: 'At least one attempt lacks a USD cost derived from the authorized pricing snapshot.',
  });
  if (!state.objectiveEvidenceComplete) blockers.push({
    code: 'OBJECTIVE_EVIDENCE_REQUIRED',
    message: 'At least one non-human assertion lacks a deterministic objective observation.',
  });
  if (!state.uiEvidenceComplete) blockers.push({
    code: 'UI_EVIDENCE_REQUIRED',
    message: 'At least one UI-family attempt lacks redacted, blind-safe desktop-host evidence.',
  });
  if (!state.artifactPublicationSafe) blockers.push({
    code: 'PUBLICATION_SAFE_ARTIFACTS_REQUIRED',
    message: 'At least one generated artifact is not marked redacted for publication.',
  });
  return blockers;
}

function summarizeExclusionReasons(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record.outcome.excluded) continue;
    const reason = record.outcome.exclusionReason || record.outcome.errorMessage || 'Excluded without a reason.';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function pairedStats(values) {
  if (values.length === 0) return { count: 0, mean: null, standardDeviation: null, confidence95: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { count: 1, mean, standardDeviation: null, confidence95: null };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = tCritical95(values.length - 1) * standardDeviation / Math.sqrt(values.length);
  return {
    count: values.length,
    mean,
    standardDeviation,
    confidence95: { lower: mean - margin, upper: mean + margin },
  };
}

export function statisticallyPositivePaired(stats) {
  return typeof stats.confidence95?.lower === 'number' && stats.confidence95.lower > 0;
}

export function controlRegressionWithinLimit(stats, limitPercentagePoints = 5) {
  return typeof stats.mean === 'number' && stats.mean >= -(limitPercentagePoints / 100);
}

function groupPlanPairs(plan) {
  const groups = new Map();
  for (const attempt of plan.attempts) {
    if (!groups.has(attempt.pairId)) groups.set(attempt.pairId, []);
    groups.get(attempt.pairId).push(attempt);
  }
  return groups.values();
}

function summarizeArm(records) {
  const scored = records.filter((record) => record.metrics.weightedTaskSuccess !== null);
  const tokens = records.reduce((totals, record) => ({
    input: totals.input + record.metrics.tokens.input,
    output: totals.output + record.metrics.tokens.output,
    cached: totals.cached + (record.metrics.tokens.cached ?? 0),
  }), { input: 0, output: 0, cached: 0 });
  return {
    attempts: records.length,
    meanWeightedTaskSuccess: scored.length
      ? scored.reduce((sum, record) => sum + record.metrics.weightedTaskSuccess, 0) / scored.length
      : null,
    totalWallTimeMs: records.reduce((sum, record) => sum + record.metrics.wallTimeMs, 0),
    totalTokens: tokens,
    totalEstimatedCostUsd: records.every((record) => typeof record.metrics.estimatedCostUsd === 'number')
      ? records.reduce((sum, record) => sum + record.metrics.estimatedCostUsd, 0)
      : null,
    totalRetries: records.reduce((sum, record) => sum + record.metrics.retries, 0),
    failures: records.filter((record) => record.outcome.status !== 'passed').length,
  };
}

function tCritical95(degreesOfFreedom) {
  const table = [
    0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045,
    2.042,
  ];
  return degreesOfFreedom <= 30 ? table[degreesOfFreedom] : 1.96;
}

function passFail(value) {
  return value ? 'PASS' : 'FAIL';
}

function gateResult(gate) {
  return gate.evaluated === false ? 'NOT EVALUATED' : passFail(gate.passed);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}pp`;
}

function interval(value) {
  return value ? `[${percent(value.lower)}, ${percent(value.upper)}]` : 'n/a';
}
