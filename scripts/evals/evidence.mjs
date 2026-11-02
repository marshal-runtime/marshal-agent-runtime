import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EVIDENCE_SCHEMA_VERSION,
  assert,
  canonicalJson,
  portablePath,
  promptDigest,
  safeSegment,
  sha256,
} from './core.mjs';
import { gradeObjectiveObservation } from './graders.mjs';

const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api[-_]?key)/i;

export async function initializeRunDirectory(runDirectory, plan, config, options = {}) {
  const root = resolve(runDirectory);
  const metadataPath = join(root, 'run-metadata.json');
  const exists = await pathExists(metadataPath);
  if (exists && !options.resume) throw new Error(`Run directory already exists; use --resume: ${root}`);
  await mkdir(root, { recursive: true });
  const metadata = {
    schemaVersion: '1.0.0',
    runId: plan.runId,
    createdAt: new Date().toISOString(),
    corpusDigest: plan.corpusDigest,
    configurationDigest: plan.configurationDigest,
    authorizationBindingDigest: plan.authorizationBindingDigest,
    seed: plan.seed,
    repetitions: plan.repetitions,
    fullCorpus: plan.fullCorpus,
    expectedAttempts: plan.expectedAttempts,
    evidencePolicy: 'append-only-publish-all-attempts',
    adapterKind: config.adapter.kind,
    evidenceClassificationPolicy: 'per-attempt-adapter-result',
    adapterCanProduceLiveEvidence: config.adapter.kind === 'command',
  };
  if (exists) {
    const prior = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert(prior.runId === metadata.runId, 'Resume runId mismatch.');
    assert(prior.corpusDigest === metadata.corpusDigest, 'Resume corpus digest mismatch.');
    assert(prior.configurationDigest === metadata.configurationDigest, 'Resume configuration digest mismatch.');
    assert(prior.authorizationBindingDigest === metadata.authorizationBindingDigest, 'Resume authorization binding digest mismatch.');
  } else {
    await writeJson(metadataPath, metadata);
    await writeJson(join(root, 'plan.json'), plan);
    await writeJson(join(root, 'config.snapshot.json'), redactConfig(config));
  }
  return {
    root,
    evidencePath: join(root, 'evidence.jsonl'),
    metadataPath,
  };
}

export async function readEvidenceRecords(evidencePath) {
  if (!(await pathExists(evidencePath))) return [];
  const source = await readFile(evidencePath, 'utf8');
  if (!source.trim()) return [];
  return source.trimEnd().split(/\r?\n/).map((line, index) => {
    try {
      const record = JSON.parse(line);
      validateEvidenceRecord(record);
      return record;
    } catch (error) {
      throw new Error(`Invalid evidence JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

export async function appendEvidenceRecord(evidencePath, record) {
  validateEvidenceRecord(record);
  await appendFile(evidencePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

export async function verifyEvidenceFiles(runRoot, record) {
  for (const entry of evidenceFileEntries(record)) {
    const path = resolve(runRoot, entry.path);
    assert(isWithin(runRoot, path), `Evidence path escapes the run directory: ${entry.path}`);
    const bytes = await readFile(path);
    assert(sha256(bytes) === entry.sha256, `Evidence digest mismatch: ${entry.path}`);
  }
}

export function validateEvidenceRecord(record) {
  assert(record?.schemaVersion === EVIDENCE_SCHEMA_VERSION, `Unexpected evidence schema: ${record?.schemaVersion}`);
  assert(typeof record.attemptKey === 'string' && record.attemptKey.length > 0, 'Evidence attemptKey is required.');
  assert(/^[a-f0-9]{64}$/.test(record.promptDigest ?? ''), `Invalid prompt digest for ${record.attemptKey}.`);
  assert(/^[a-f0-9]{64}$/.test(record.configurationDigest ?? ''), `Invalid configuration digest for ${record.attemptKey}.`);
  assert(['live', 'fixture', 'unavailable'].includes(record.evidenceClass), `Invalid evidence class for ${record.attemptKey}.`);
  assert(record.metrics?.weightedTaskSuccess === null
    || (typeof record.metrics?.weightedTaskSuccess === 'number'
      && record.metrics.weightedTaskSuccess >= 0
      && record.metrics.weightedTaskSuccess <= 1), `Invalid task score for ${record.attemptKey}.`);
  assert(Array.isArray(record.evidence?.assertions), `Missing assertions for ${record.attemptKey}.`);
  for (const assertion of record.evidence.assertions) {
    assert(assertion.status === 'pending' || assertion.status === 'graded', `Invalid assertion status in ${record.attemptKey}.`);
    assert(assertion.score === null || (typeof assertion.score === 'number' && assertion.score >= 0 && assertion.score <= 1), `Invalid assertion score in ${record.attemptKey}.`);
  }
  for (const entry of evidenceFileEntries(record)) {
    assert(typeof entry.path === 'string' && entry.path.length > 0, `Invalid evidence path in ${record.attemptKey}.`);
    assert(/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''), `Invalid evidence digest in ${record.attemptKey}.`);
  }
}

export async function prepareAttemptDirectory(runRoot, attempt) {
  const directory = join(
    runRoot,
    'attempts',
    `${String(attempt.orderIndex).padStart(4, '0')}-${safeSegment(attempt.caseId)}-${safeSegment(attempt.treatmentId)}-r${attempt.repetition}`,
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function captureAttemptRecord({
  run,
  plan,
  attempt,
  item,
  config,
  adapterResult,
  attemptDirectory,
  startedAt,
  completedAt,
}) {
  const redactions = config.redactions ?? [];
  const trace = redactValue(adapterResult.trace, redactions);
  const finalOutput = redactText(adapterResult.finalOutput, redactions);
  const traceEvidence = await writeEvidenceFile(run.root, join(attemptDirectory, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`, {
    mediaType: 'application/json',
    redacted: true,
  });
  const finalOutputEvidence = await writeEvidenceFile(run.root, join(attemptDirectory, 'final-output.txt'), finalOutput, {
    mediaType: 'text/plain; charset=utf-8',
    redacted: true,
  });
  const phaseOutputs = [];
  for (const [index, phase] of adapterResult.phaseOutputs.entries()) {
    const phaseId = safeSegment(phase.id ?? item.phases[index]?.id ?? `phase-${index + 1}`);
    phaseOutputs.push(await writeEvidenceFile(
      run.root,
      join(attemptDirectory, 'phases', `${String(index + 1).padStart(2, '0')}-${phaseId}.txt`),
      redactText(String(phase.output ?? ''), redactions),
      { mediaType: 'text/plain; charset=utf-8', redacted: true },
    ));
  }
  const artifacts = await captureSuppliedFiles(
    run.root,
    attemptDirectory,
    'generated',
    adapterResult.generatedFiles,
    redactions,
  );
  const uiEvidence = await captureSuppliedFiles(
    run.root,
    attemptDirectory,
    'ui',
    adapterResult.uiEvidence,
    redactions,
  );
  const permissions = await writeEvidenceFile(
    run.root,
    join(attemptDirectory, 'permissions.json'),
    `${JSON.stringify(redactValue(adapterResult.permissions, redactions), null, 2)}\n`,
    { mediaType: 'application/json', redacted: true },
  );
  const receipts = await writeEvidenceFile(
    run.root,
    join(attemptDirectory, 'receipts.json'),
    `${JSON.stringify(redactValue(adapterResult.receipts, redactions), null, 2)}\n`,
    { mediaType: 'application/json', redacted: true },
  );
  const observedTools = await writeEvidenceFile(
    run.root,
    join(attemptDirectory, 'observed-tools.json'),
    `${JSON.stringify(redactValue(adapterResult.observedTools, redactions), null, 2)}\n`,
    { mediaType: 'application/json', redacted: true },
  );
  const timings = await writeEvidenceFile(
    run.root,
    join(attemptDirectory, 'timings.json'),
    `${JSON.stringify(adapterResult.timings, null, 2)}\n`,
    { mediaType: 'application/json', redacted: false },
  );
  const availability = await writeEvidenceFile(
    run.root,
    join(attemptDirectory, 'availability.json'),
    `${JSON.stringify(adapterResult.availability ?? {}, null, 2)}\n`,
    { mediaType: 'application/json', redacted: false },
  );
  const assertions = gradeAssertions(item, adapterResult, config.configurationDigest, attempt);
  const weightedTaskSuccess = assertions.some((assertion) => assertion.status === 'pending')
    ? null
    : weightedScore(item, assertions);
  const fixtureDigest = sha256(canonicalJson({
    fixtureManifest: config.verifiedInputs.fixtureManifest.sha256,
    networkFixture: config.verifiedInputs.networkFixture.sha256,
    phaseFixtures: item.phases.map((phase) => phase.fixture ?? null),
    workspaces: item.phases.map((phase) => phase.workspace),
  }));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: plan.runId,
    attemptKey: attempt.attemptKey,
    caseId: item.id,
    family: item.family,
    treatmentId: attempt.treatmentId,
    repetition: attempt.repetition,
    pairId: attempt.pairId,
    pairPosition: attempt.pairPosition,
    orderIndex: attempt.orderIndex,
    evidenceClass: adapterResult.evidenceClass,
    startedAt,
    completedAt,
    promptDigest: promptDigest(item),
    configurationDigest: config.configurationDigest,
    environment: {
      corpusDigest: plan.corpusDigest,
      repositoryCommit: config.fixed.repositoryCommit,
      repositoryDirty: config.fixed.repositoryDirty,
      harness: config.fixed.harness,
      harnessVersion: config.fixed.harnessVersion,
      model: config.fixed.model,
      reasoning: config.fixed.reasoning,
      os: config.fixed.os,
      fixtureDigest,
      fixtureManifestDigest: config.verifiedInputs.fixtureManifest.sha256,
      networkFixtureDigest: config.verifiedInputs.networkFixture.sha256,
      toolManifestDigest: config.verifiedInputs.toolManifest.sha256,
      timeoutMs: item.budgets.timeoutMs,
      maxTurns: item.budgets.maxTurns,
      maxRetries: config.fixed.maxRetries,
      adapterDigest: config.verifiedAdapter.sha256,
      releaseAttestations: normalizeReleaseAttestations(adapterResult.releaseAttestations),
      confinementLease: adapterResult.confinementLease,
    },
    outcome: {
      status: adapterResult.status,
      excluded: adapterResult.excluded,
      ...(adapterResult.exclusionReason ? { exclusionReason: adapterResult.exclusionReason } : {}),
      ...(adapterResult.errorCategory ? { errorCategory: adapterResult.errorCategory } : {}),
      ...(adapterResult.errorMessage ? { errorMessage: redactText(adapterResult.errorMessage, redactions) } : {}),
    },
    metrics: {
      weightedTaskSuccess,
      wallTimeMs: adapterResult.wallTimeMs || Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      ...(adapterResult.timeToUsefulResultMs === undefined ? {} : { timeToUsefulResultMs: adapterResult.timeToUsefulResultMs }),
      toolCalls: adapterResult.toolCalls,
      retries: adapterResult.retries,
      ...(adapterResult.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: adapterResult.estimatedCostUsd }),
      tokens: adapterResult.tokens,
    },
    evidence: {
      trace: traceEvidence,
      finalOutput: finalOutputEvidence,
      phaseOutputs,
      artifacts,
      permissions,
      receipts,
      observedTools,
      timings,
      availability,
      uiEvidence,
      screenshots: uiEvidence.filter((entry) => entry.kind === 'screenshot'),
      assertions,
    },
  };
}

function normalizeReleaseAttestations(value = {}) {
  const fields = [
    'liveAuthorizationDigest',
    'networkEnforcementDigest',
    'processConfinementProfileDigest',
    'processConfinementMeasurementDigest',
    'processConfinementReceiptBundleDigest',
    'processConfinementCleanupDigest',
    'objectiveOracleDigest',
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    /^[a-f0-9]{64}$/.test(value[field] ?? '') ? value[field] : null,
  ]));
}

export async function buildBlindReviewBundle(runRoot, corpus, records) {
  const blindRoot = join(runRoot, 'blind');
  await mkdir(blindRoot, { recursive: true });
  const review = [];
  const mapping = [];
  for (const record of records) {
    const item = corpus.cases.find((candidate) => candidate.id === record.caseId);
    for (const assertion of record.evidence.assertions.filter((candidate) => candidate.blind)) {
      const entryRoot = join(blindRoot, assertion.blindId);
      await mkdir(entryRoot, { recursive: true });
      const copiedFinal = join(entryRoot, 'final-output.txt');
      const blindOutput = blindRedact(await readFile(join(runRoot, record.evidence.finalOutput.path), 'utf8'));
      await writeFile(copiedFinal, blindOutput, 'utf8');
      const ui = [];
      for (const [index, source] of record.evidence.uiEvidence.entries()) {
        assert(source.blindSafe === true, `UI evidence ${source.path} must be pre-redacted and marked blindSafe before human grading.`);
        const extension = source.mediaType?.includes('png') ? '.png'
          : source.mediaType?.includes('webm') ? '.webm'
            : source.mediaType?.includes('mp4') ? '.mp4'
              : '.bin';
        const destination = join(entryRoot, `ui-${String(index + 1).padStart(2, '0')}${extension}`);
        await copyFile(join(runRoot, source.path), destination);
        ui.push({
          path: portablePath(relative(runRoot, destination)),
          sha256: source.sha256,
          mediaType: source.mediaType,
        });
      }
      review.push({
        schemaVersion: '1.0.0',
        blindId: assertion.blindId,
        caseId: record.caseId,
        title: item.title,
        prompts: item.phases.map((phase) => phase.prompt),
        assertionId: assertion.id,
        rubric: item.scoring.assertions.find((candidate) => candidate.id === assertion.id)?.description,
        finalOutput: {
          path: portablePath(relative(runRoot, copiedFinal)),
          sha256: sha256(blindOutput),
          mediaType: record.evidence.finalOutput.mediaType,
        },
        uiEvidence: ui,
        requestedGrade: { score: 'number from 0 to 1', notes: 'brief evidence-based rationale' },
      });
      mapping.push({
        blindId: assertion.blindId,
        attemptKey: record.attemptKey,
        treatmentId: record.treatmentId,
        repetition: record.repetition,
        assertionId: assertion.id,
      });
    }
  }
  await writeJsonLines(join(blindRoot, 'review.jsonl'), review);
  await writeJsonLines(join(blindRoot, 'private-map.jsonl'), mapping);
  return { reviewCount: review.length };
}

export function applyHumanGrades(record, gradesByBlindId, item) {
  const assertions = record.evidence.assertions.map((assertion) => {
    if (!assertion.blind || assertion.status !== 'pending') return assertion;
    const grade = gradesByBlindId.get(assertion.blindId);
    if (!grade) return assertion;
    assert(typeof grade.score === 'number' && grade.score >= 0 && grade.score <= 1, `Invalid human score for ${assertion.blindId}.`);
    assert(typeof grade.grader === 'string' && grade.grader.length > 0, `Missing grader for ${assertion.blindId}.`);
    return {
      ...assertion,
      status: 'graded',
      score: grade.score,
      grader: grade.grader,
      notes: grade.notes ?? assertion.notes,
    };
  });
  return {
    ...record,
    metrics: {
      ...record.metrics,
      weightedTaskSuccess: assertions.some((assertion) => assertion.status === 'pending')
        ? null
        : weightedScore(item, assertions),
    },
    evidence: { ...record.evidence, assertions },
  };
}

export async function loadHumanGrades(path) {
  if (!path) return new Map();
  const records = await readJsonLines(resolve(path));
  const grades = new Map();
  for (const record of records) {
    assert(typeof record.blindId === 'string', 'Human grade is missing blindId.');
    assert(!grades.has(record.blindId), `Duplicate human grade: ${record.blindId}`);
    grades.set(record.blindId, record);
  }
  return grades;
}

function gradeAssertions(item, result, configurationDigest, attempt) {
  return item.scoring.assertions.map((assertion) => {
    if (assertion.kind === 'human-rubric') {
      return {
        id: assertion.id,
        kind: assertion.kind,
        weight: assertion.weight,
        status: 'pending',
        score: null,
        grader: 'blind-human-pending',
        blind: true,
        blindId: sha256(`${configurationDigest}\u0000${attempt.attemptKey}\u0000${assertion.id}`).slice(0, 24),
      };
    }
    if (result.status !== 'passed') {
      return {
        id: assertion.id,
        kind: assertion.kind,
        weight: assertion.weight,
        status: 'graded',
        score: 0,
        grader: 'objective-attempt-status',
        blind: false,
        notes: `Attempt status was ${result.status}.`,
      };
    }
    const graded = gradeObjectiveObservation(assertion, result.assertionObservations[assertion.id]);
    return {
      id: assertion.id,
      kind: assertion.kind,
      weight: assertion.weight,
      status: 'graded',
      score: graded.score,
      grader: graded.grader,
      blind: false,
      ...(graded.notes ? { notes: graded.notes } : {}),
    };
  });
}

function weightedScore(item, assertions) {
  const weights = new Map(item.scoring.assertions.map((assertion) => [assertion.id, assertion.weight]));
  return assertions.reduce((total, assertion) => total + assertion.score * weights.get(assertion.id), 0);
}

async function captureSuppliedFiles(runRoot, attemptRoot, category, files, redactions) {
  const output = [];
  for (const [index, file] of files.entries()) {
    const name = `${String(index + 1).padStart(3, '0')}-${safeSegment(file.name ?? `${category}-${index + 1}`)}`;
    const destination = join(attemptRoot, category, name);
    let bytes;
    let redacted = file.redacted === true;
    if (typeof file.content === 'string') {
      const value = redactText(file.content, redactions);
      redacted = true;
      bytes = Buffer.from(value, 'utf8');
    } else if (typeof file.contentBase64 === 'string') {
      bytes = Buffer.from(file.contentBase64, 'base64');
    } else if (typeof file.path === 'string') {
      const source = isAbsolute(file.path) ? resolve(file.path) : resolve(attemptRoot, file.path);
      assert(isWithin(attemptRoot, source), `Adapter evidence path escapes its attempt directory: ${file.path}`);
      bytes = await readFile(source);
      const suppliedMediaType = file.mediaType ?? 'application/octet-stream';
      if (isTextMediaType(suppliedMediaType)) {
        bytes = Buffer.from(redactText(bytes.toString('utf8'), redactions), 'utf8');
        redacted = true;
      }
    } else {
      throw new Error(`Evidence file ${name} has no content, contentBase64, or bounded path.`);
    }
    const entry = await writeEvidenceFile(runRoot, destination, bytes, {
      mediaType: file.mediaType ?? 'application/octet-stream',
      redacted,
    });
    output.push({
      ...entry,
      ...(file.kind ? { kind: file.kind } : {}),
      ...(file.blindSafe === undefined ? {} : { blindSafe: file.blindSafe === true }),
    });
  }
  return output;
}

function isTextMediaType(value) {
  return value.startsWith('text/')
    || value === 'application/json'
    || value.endsWith('+json');
}

async function writeEvidenceFile(runRoot, path, content, metadata) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  const bytes = await readFile(path);
  return {
    path: portablePath(relative(runRoot, path)),
    sha256: sha256(bytes),
    mediaType: metadata.mediaType,
    redacted: metadata.redacted,
  };
}

function redactConfig(config) {
  return redactValue({
    schemaVersion: config.schemaVersion,
    runId: config.runId,
    corpus: config.corpus,
    repetitions: config.repetitions,
    seed: config.seed,
    adapter: config.adapter.kind === 'command'
      ? {
          kind: 'command',
          command: config.adapter.command,
          args: config.adapter.args ?? [],
          ...(config.adapter.cwd ? { cwd: config.adapter.cwd } : {}),
          driverFile: config.adapter.driverFile,
          driverDigest: config.adapter.driverDigest,
          driverDependencies: config.adapter.driverDependencies ?? [],
          driverOptions: config.adapter.driverOptions ?? {},
        }
      : { ...config.adapter },
    fixed: config.fixed,
    inputs: config.inputs,
    selection: config.selection,
    redactions: config.redactions?.map(() => '[REDACTION VALUE OMITTED]'),
    configurationDigest: config.configurationDigest,
  }, config.redactions ?? []);
}

function redactValue(value, literals, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value, literals);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, literals));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, literals, childKey),
    ]));
  }
  return value;
}

function redactText(value, literals) {
  let output = String(value);
  for (const literal of literals) output = output.split(literal).join('[REDACTED]');
  return output;
}

function blindRedact(value) {
  return value
    .replace(/codex-(?:baseline|marshal)/gi, '[ARM]')
    .replace(/codex\s+with\s+marshal/gi, '[ARM]')
    .replace(/stock\s+codex/gi, '[ARM]')
    .replace(/runtime_[a-z0-9_]+/gi, '[TOOL]')
    .replace(/marshal/gi, '[TREATMENT]');
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonLines(path, values) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''), 'utf8');
}

async function readJsonLines(path) {
  const source = await readFile(path, 'utf8');
  if (!source.trim()) return [];
  return source.trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function evidenceFileEntries(record) {
  const evidence = record.evidence ?? {};
  return [
    evidence.trace,
    evidence.finalOutput,
    ...(evidence.phaseOutputs ?? []),
    ...(evidence.artifacts ?? []),
    evidence.permissions,
    evidence.receipts,
    evidence.observedTools,
    evidence.timings,
    evidence.availability,
    ...(evidence.uiEvidence ?? []),
  ].filter(Boolean);
}
