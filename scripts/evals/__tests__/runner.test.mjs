import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createMatchedPlan, loadCorpus, loadRunConfig, sha256 } from '../core.mjs';
import { readEvidenceRecords } from '../evidence.mjs';
import { gradeObjectiveObservation } from '../graders.mjs';
import {
  controlRegressionWithinLimit,
  pairedStats,
  statisticallyPositivePaired,
} from '../report-lib.mjs';
import { regenerateReport } from '../report.mjs';
import { runEvaluation } from '../run.mjs';
import { offlineSmokeSelection } from '../prepare-offline-smoke.mjs';

const corpusRoot = resolve('docs/evals/v1');

test('full-corpus offline preparation removes only the case filter and freezes 108 attempts', async () => {
  const profile = {
    selection: {
      caseIds: ['control-read-only-architecture-answer'],
      treatmentIds: ['codex-baseline', 'codex-marshal'],
    },
  };
  const selection = offlineSmokeSelection(profile, true);
  const corpus = await loadCorpus(corpusRoot);
  const plan = createMatchedPlan(corpus, {
    runId: 'offline-full-corpus-preflight-v1',
    seed: 'offline-full-corpus-v1',
    repetitions: 3,
    selection,
    configurationDigest: '1'.repeat(64),
    authorizationBindingDigest: '2'.repeat(64),
  });

  assert.deepEqual(selection, { treatmentIds: ['codex-baseline', 'codex-marshal'] });
  assert.equal(plan.fullCorpus, true);
  assert.equal(plan.caseCount, 18);
  assert.equal(plan.expectedAttempts, 108);
  assert.deepEqual(offlineSmokeSelection(profile, false), profile.selection);
});

test('paired planning is deterministic, randomized, and contains both headline arms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-eval-plan-'));
  const configPath = await writeFixtureConfig(root, { adapterKind: 'dry-run' });
  const config = await loadRunConfig(configPath);
  const corpus = await loadCorpus(corpusRoot);
  const first = createMatchedPlan(corpus, config);
  const second = createMatchedPlan(corpus, config);

  assert.deepEqual(first, second);
  assert.equal(first.repetitions, 3);
  assert.equal(first.expectedAttempts, 12);
  for (const pairId of new Set(first.attempts.map((attempt) => attempt.pairId))) {
    const pair = first.attempts.filter((attempt) => attempt.pairId === pairId);
    assert.deepEqual(new Set(pair.map((attempt) => attempt.treatmentId)), new Set(['codex-baseline', 'codex-marshal']));
    assert.deepEqual(new Set(pair.map((attempt) => attempt.pairPosition)), new Set([1, 2]));
  }
});

test('fixture runner publishes every attempt, redacts traces, resumes, and emits blind UI grading work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-eval-run-'));
  const configPath = await writeFixtureConfig(root, { adapterKind: 'fixture' });
  const output = join(root, 'published-run');
  const first = await runEvaluation({ config: configPath, output });

  assert.equal(first.dryRun, false);
  assert.equal(first.records.length, 12);
  assert.equal(first.report.releaseClaim.eligible, false);
  assert.deepEqual(first.report.evidenceClassification, ['fixture']);
  assert.deepEqual(
    first.report.releaseReadiness.prerequisiteBlockers.map((entry) => entry.code),
    [
      'LIVE_MATCHED_EVIDENCE_REQUIRED',
      'FULL_CORPUS_REQUIRED',
      'COMPLETE_ATTEMPT_SET_REQUIRED',
      'RELEASE_ATTESTATIONS_REQUIRED',
    ],
  );
  assert.equal(first.report.releaseReadiness.statisticalGatesEvaluated, false);
  assert.equal(first.report.gates.controlRegressionAtMostFivePoints.evaluated, false);
  assert.equal(first.report.gates.releaseAttestations.passed, false);
  assert.equal(first.report.gates.costCaptured.passed, true);
  assert.equal(first.records[0].environment.confinementLease.status, 'unavailable');
  assert.equal(first.records[0].environment.releaseAttestations.processConfinementMeasurementDigest, null);
  assert.equal(first.records[0].environment.releaseAttestations.processConfinementReceiptBundleDigest, null);
  assert.equal(first.records[0].environment.releaseAttestations.processConfinementCleanupDigest, null);
  const markdown = await readFile(join(output, 'report.md'), 'utf8');
  assert.match(markdown, /No stock Codex baseline was run/);
  assert.match(markdown, /Ordinary-control regression[^\n]+NOT EVALUATED/);
  const evidenceLines = (await readFile(join(output, 'evidence.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(evidenceLines.length, 12);
  const trace = await readFile(join(output, first.records[0].evidence.trace.path), 'utf8');
  assert.doesNotMatch(trace, /fixture-secret-value/);
  assert.match(trace, /\[REDACTED\]/);
  const blindReview = (await readFile(join(output, 'blind', 'review.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(blindReview.length, 6);
  assert.equal(blindReview.some((entry) => 'treatmentId' in entry), false);

  const reportBeforeResume = await readFile(join(output, 'report.json'), 'utf8');
  const resumed = await runEvaluation({ config: configPath, output, resume: true });
  assert.equal(resumed.records.length, 12);
  assert.equal((await readEvidenceRecords(join(output, 'evidence.jsonl'))).length, 12);
  assert.equal(await readFile(join(output, 'report.json'), 'utf8'), reportBeforeResume);

  const gradesPath = join(root, 'human-grades.jsonl');
  await writeFile(gradesPath, blindReview.map((entry) => JSON.stringify({
    blindId: entry.blindId,
    score: 0.75,
    grader: 'test-human-grader',
    notes: 'Fixture-only test grade.',
  })).join('\n') + '\n');
  const report = await regenerateReport({ run: output, corpus: corpusRoot, humanGrades: gradesPath });
  assert.equal(report.completeness.pendingHumanGrades.length, 0);
  assert.equal(report.releaseClaim.eligible, false, 'Fixture evidence must never become release eligible.');
});

test('runner rejects a live writer and recovers a definitely stale writer lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-eval-writer-lock-'));
  const configPath = await writeFixtureConfig(root, { adapterKind: 'fixture' });
  const output = join(root, 'published-run');
  const first = await runEvaluation({ config: configPath, output });
  assert.equal(first.records.length, 12);

  const lockPath = join(output, '.writer.lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }), 'utf8');
  await assert.rejects(
    () => runEvaluation({ config: configPath, output, resume: true }),
    /another evaluation writer owns this run directory/i,
  );
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), 'utf8');

  const resumed = await runEvaluation({ config: configPath, output, resume: true });
  assert.equal(resumed.records.length, 12);
  assert.equal((await readEvidenceRecords(join(output, 'evidence.jsonl'))).length, 12);
});

test('paired confidence interval and the five-point control rule are strict', () => {
  const positive = pairedStats([0.2, 0.21, 0.19, 0.2]);
  assert.equal(statisticallyPositivePaired(positive), true);
  assert.equal(controlRegressionWithinLimit({ mean: -0.05 }), true);
  assert.equal(controlRegressionWithinLimit({ mean: -0.051 }), false);
});

test('objective graders compare extracted evidence without treatment-specific code', () => {
  const assertion = { id: 'oracle-check', kind: 'state' };
  assert.equal(gradeObjectiveObservation(assertion, { type: 'boolean', actual: true }).score, 1);
  assert.equal(gradeObjectiveObservation(assertion, {
    type: 'exact-json', actual: { b: 2, a: 1 }, expected: { a: 1, b: 2 },
  }).score, 1);
  assert.equal(gradeObjectiveObservation(assertion, {
    type: 'contains-all', actual: 'alpha beta', expected: ['alpha', 'beta'],
  }).score, 1);
  assert.equal(gradeObjectiveObservation(assertion, {
    type: 'numeric-range', actual: 250, maximum: 249,
  }).score, 0);
  assert.equal(gradeObjectiveObservation(assertion, undefined).score, 0);
});

test('command adapter digest includes every declared local security dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-eval-driver-digest-'));
  const basePath = await writeFixtureConfig(root, { adapterKind: 'dry-run' });
  const config = JSON.parse(await readFile(basePath, 'utf8'));
  const driver = join(root, 'driver.mjs');
  const dependency = join(root, 'security-helper.mjs');
  await writeFile(driver, 'export const driver = true;\n', 'utf8');
  await writeFile(dependency, 'export const security = true;\n', 'utf8');
  config.adapter = {
    kind: 'command',
    command: process.execPath,
    driverFile: driver,
    driverDigest: sha256(await readFile(driver)),
    driverDependencies: [{ path: dependency, sha256: sha256(await readFile(dependency)) }],
  };
  await writeFile(basePath, JSON.stringify(config, null, 2), 'utf8');
  const loaded = await loadRunConfig(basePath);
  assert.equal(loaded.verifiedAdapter.dependencies.length, 1);
  const firstDigest = loaded.verifiedAdapter.sha256;
  await writeFile(dependency, 'export const security = false;\n', 'utf8');
  await assert.rejects(() => loadRunConfig(basePath), /dependency 1 digest mismatch/i);
  assert.match(firstDigest, /^[a-f0-9]{64}$/);
});

test('executable command adapter cannot forge runner-verified confinement eligibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-eval-forged-confinement-'));
  const configPath = await writeFixtureConfig(root, { adapterKind: 'dry-run' });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const driver = resolve('scripts/evals/__tests__/fixtures/fake-forged-confinement-adapter.mjs');
  config.adapter = {
    kind: 'command',
    command: process.execPath,
    args: [driver],
    driverFile: driver,
    driverDigest: sha256(await readFile(driver)),
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  const completed = await runEvaluation({ config: configPath, output: join(root, 'run') });
  assert.equal(completed.records.length > 0, true);
  assert.equal(completed.records.every((record) => record.environment.confinementLease.releaseEligible === false), true);
  assert.equal(completed.records.every((record) => record.environment.confinementLease.status === 'unavailable'), true);
  assert.match(completed.records[0].environment.confinementLease.blockers.join('\n'), /cannot self-assert/i);
  assert.equal(completed.report.gates.releaseAttestations.passed, false);
  assert.equal(completed.report.releaseClaim.eligible, false);
});

async function writeFixtureConfig(root, options) {
  const inputs = {
    'tools.json': JSON.stringify({ nativeTools: ['shell', 'browser'], version: 'fixture' }),
    'fixtures.json': JSON.stringify({ fixtures: ['fixture-only'], version: 'fixture' }),
    'network.json': JSON.stringify({ mode: 'recorded', responses: [] }),
  };
  for (const [name, contents] of Object.entries(inputs)) await writeFile(join(root, name), contents);
  const results = {
    schemaVersion: '1.0.0',
    defaultResult: {
      status: 'passed',
      finalOutput: 'Deterministic fixture output.',
      trace: [{ event: 'fixture', authorization: 'fixture-secret-value', note: 'fixture-secret-value' }],
      phaseOutputs: [{ id: 'request', output: 'Fixture phase output.' }],
      generatedFiles: [{ name: 'result.txt', content: 'fixture artifact', mediaType: 'text/plain' }],
      permissions: [{ capability: 'fixture.read', decision: 'allow' }],
      receipts: [{ id: 'receipt-fixture', status: 'success' }],
      observedTools: ['shell', 'browser'],
      uiEvidence: [{ name: 'screen.txt', kind: 'screenshot', content: 'fixture UI placeholder', mediaType: 'text/plain', blindSafe: true }],
      wallTimeMs: 10,
      timeToUsefulResultMs: 5,
      toolCalls: 2,
      retries: 0,
      estimatedCostUsd: 0,
      tokens: { input: 100, output: 50, cached: 10 },
    },
    byTreatment: {
      'codex-baseline': { objectiveScore: 0.55 },
      'codex-marshal': { objectiveScore: 0.75 },
    },
  };
  const resultsText = JSON.stringify(results);
  await writeFile(join(root, 'results.json'), resultsText);
  const config = {
    schemaVersion: '1.0.0',
    runId: 'fixture-matched-run',
    corpus: corpusRoot,
    repetitions: 3,
    seed: 'fixed-seed-2026',
    adapter: options.adapterKind === 'fixture'
      ? { kind: 'fixture', resultsFile: 'results.json', resultsSha256: sha256(resultsText) }
      : { kind: 'dry-run' },
    fixed: {
      harness: 'codex',
      harnessVersion: 'fixture-version',
      model: 'fixture-model',
      reasoning: 'fixture-reasoning',
      repositoryCommit: '0000000-fixture',
      repositoryDirty: false,
      os: 'fixture-os',
      maxRetries: 1,
      maxOutputBytes: 1048576,
    },
    inputs: Object.fromEntries(Object.entries(inputs).map(([name, contents]) => [
      name === 'tools.json' ? 'toolManifest' : name === 'fixtures.json' ? 'fixtureManifest' : 'networkFixture',
      { path: name, sha256: sha256(contents) },
    ])),
    selection: {
      caseIds: ['ui-inline-incident-card', 'control-one-off-data-summary'],
    },
    redactions: ['fixture-secret-value'],
  };
  const configPath = join(root, 'run-config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
