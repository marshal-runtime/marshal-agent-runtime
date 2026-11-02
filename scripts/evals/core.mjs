import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const EVIDENCE_SCHEMA_VERSION = '1.2.0';
export const RUN_CONFIG_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_CORPUS_ROOT = resolve('docs/evals/v1');
export const HEADLINE_TREATMENT_COUNT = 2;

export async function loadCorpus(corpusRoot = DEFAULT_CORPUS_ROOT) {
  const root = resolve(corpusRoot);
  const manifestPath = join(root, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert(manifest.status === 'frozen', 'Evaluation corpus must be frozen.');
  assert(manifest.runPolicy?.paired === true, 'Evaluation corpus must require paired runs.');
  assert(manifest.runPolicy?.randomizedOrder === true, 'Evaluation corpus must require randomized order.');
  assert(manifest.runPolicy?.publishAllAttempts === true, 'Evaluation corpus must publish every attempt.');
  assert(manifest.runPolicy?.minimumRepetitions >= 3, 'Evaluation corpus requires at least three repetitions.');

  const treatments = JSON.parse(await readFile(join(root, manifest.treatmentsFile), 'utf8'));
  const caseSets = await Promise.all(
    manifest.caseFiles.map(async (file) => ({
      file,
      value: JSON.parse(await readFile(join(root, file), 'utf8')),
    })),
  );
  const cases = caseSets.flatMap(({ file, value }) =>
    value.cases.map((item) => ({ ...item, family: value.family, sourceFile: file })),
  );
  const corpusDigest = sha256(canonicalJson({
    manifest: sha256(manifestBytes),
    frozenFiles: manifest.frozenFiles,
  }));
  return { root, manifest, treatments: treatments.treatments, cases, corpusDigest };
}

export async function loadRunConfig(configPath) {
  const absolutePath = resolve(configPath);
  const config = JSON.parse(await readFile(absolutePath, 'utf8'));
  validateRunConfig(config);
  const configRoot = dirname(absolutePath);
  const verifiedInputs = {};
  for (const name of ['toolManifest', 'fixtureManifest', 'networkFixture']) {
    verifiedInputs[name] = await verifyInputFile(config.inputs[name], configRoot, name);
  }
  let verifiedAdapter;
  if (config.adapter.kind === 'fixture') {
    verifiedAdapter = await verifyInputFile(
      { path: config.adapter.resultsFile, sha256: config.adapter.resultsSha256 },
      configRoot,
      'fixture adapter results',
    );
  } else if (config.adapter.kind === 'command') {
    const driver = await verifyInputFile(
      { path: config.adapter.driverFile, sha256: config.adapter.driverDigest },
      configRoot,
      'command adapter driver',
    );
    const dependencies = await Promise.all((config.adapter.driverDependencies ?? []).map((input, index) =>
      verifyInputFile(input, configRoot, `command adapter dependency ${index + 1}`)));
    verifiedAdapter = {
      ...driver,
      dependencies,
      sha256: sha256(canonicalJson([driver.sha256, ...dependencies.map((item) => item.sha256)])),
    };
  }
  const normalized = {
    ...config,
    configPath: absolutePath,
    configRoot,
    corpusRoot: resolve(configRoot, config.corpus),
    verifiedInputs,
    verifiedAdapter,
  };
  const digestableConfig = {
    ...config,
    inputs: Object.fromEntries(
      Object.entries(verifiedInputs).map(([name, input]) => [name, {
        path: portablePath(relative(configRoot, input.path)),
        sha256: input.sha256,
      }]),
    ),
  };
  normalized.configurationDigest = sha256(canonicalJson(digestableConfig));
  const authorizationConfig = structuredClone(digestableConfig);
  if (authorizationConfig.adapter?.driverOptions) {
    delete authorizationConfig.adapter.driverOptions.liveAuthorization;
  }
  normalized.authorizationBindingDigest = sha256(canonicalJson(authorizationConfig));
  return normalized;
}

export function validateRunConfig(config) {
  assert(config?.schemaVersion === RUN_CONFIG_SCHEMA_VERSION, 'Unexpected run config schemaVersion.');
  assert(typeof config.runId === 'string' && /^[a-z0-9][a-z0-9._-]+$/.test(config.runId), 'runId must be stable and filesystem-safe.');
  assert(typeof config.corpus === 'string' && config.corpus.length > 0, 'corpus is required.');
  assert(Number.isInteger(config.repetitions) && config.repetitions >= 3, 'At least three repetitions are required.');
  assert(typeof config.seed === 'string' && config.seed.length >= 8, 'A fixed seed of at least eight characters is required.');
  assert(config.adapter && ['dry-run', 'fixture', 'command'].includes(config.adapter.kind), 'adapter.kind must be dry-run, fixture, or command.');
  if (config.adapter.kind === 'fixture') {
    assert(typeof config.adapter.resultsFile === 'string' && config.adapter.resultsFile.length > 0, 'Fixture adapter requires resultsFile.');
    assert(/^[a-f0-9]{64}$/.test(config.adapter.resultsSha256 ?? ''), 'Fixture adapter requires resultsSha256.');
  }
  if (config.adapter.kind === 'command') {
    assert(typeof config.adapter.command === 'string' && config.adapter.command.length > 0, 'Command adapter requires command.');
    assert(config.adapter.args === undefined || Array.isArray(config.adapter.args), 'adapter.args must be an array.');
    assert(typeof config.adapter.driverFile === 'string' && config.adapter.driverFile.length > 0, 'Command adapter requires driverFile.');
    assert(/^[a-f0-9]{64}$/.test(config.adapter.driverDigest ?? ''), 'Command adapter requires a verified driverDigest.');
    assert(config.adapter.driverDependencies === undefined || Array.isArray(config.adapter.driverDependencies), 'adapter.driverDependencies must be an array.');
    assert(new Set((config.adapter.driverDependencies ?? []).map((item) => item.path)).size === (config.adapter.driverDependencies ?? []).length, 'adapter.driverDependencies cannot contain duplicate paths.');
    for (const dependency of config.adapter.driverDependencies ?? []) {
      assert(typeof dependency?.path === 'string' && dependency.path.length > 0, 'Each adapter driver dependency needs a path.');
      assert(/^[a-f0-9]{64}$/.test(dependency.sha256 ?? ''), 'Each adapter driver dependency needs an exact SHA-256 digest.');
    }
    assert(config.adapter.driverOptions === undefined
      || (config.adapter.driverOptions && typeof config.adapter.driverOptions === 'object' && !Array.isArray(config.adapter.driverOptions)),
    'adapter.driverOptions must be an object when supplied.');
  }
  const fixed = config.fixed;
  for (const key of ['harness', 'harnessVersion', 'model', 'reasoning', 'repositoryCommit', 'os']) {
    assert(typeof fixed?.[key] === 'string' && fixed[key].length > 0, `fixed.${key} is required.`);
  }
  assert(typeof fixed.repositoryDirty === 'boolean', 'fixed.repositoryDirty must be boolean.');
  assert(Number.isInteger(fixed.maxRetries) && fixed.maxRetries >= 0, 'fixed.maxRetries must be a non-negative integer.');
  assert(Number.isInteger(fixed.maxOutputBytes) && fixed.maxOutputBytes >= 1024, 'fixed.maxOutputBytes must be at least 1024.');
  assert(config.inputs && typeof config.inputs === 'object', 'inputs are required.');
  for (const name of ['toolManifest', 'fixtureManifest', 'networkFixture']) {
    const input = config.inputs[name];
    assert(typeof input?.path === 'string' && input.path.length > 0, `inputs.${name}.path is required.`);
    assert(/^[a-f0-9]{64}$/.test(input.sha256 ?? ''), `inputs.${name}.sha256 must be an exact SHA-256 digest.`);
  }
  if (config.selection?.caseIds !== undefined) {
    assert(Array.isArray(config.selection.caseIds) && config.selection.caseIds.length > 0, 'selection.caseIds must be non-empty.');
    assert(new Set(config.selection.caseIds).size === config.selection.caseIds.length, 'selection.caseIds cannot contain duplicates.');
  }
  if (config.redactions !== undefined) {
    assert(Array.isArray(config.redactions) && config.redactions.every((value) => typeof value === 'string' && value.length > 0), 'redactions must contain non-empty literal strings.');
  }
}

export function createMatchedPlan(corpus, config) {
  assert(config.repetitions >= corpus.manifest.runPolicy.minimumRepetitions, 'Configured repetitions are below the corpus minimum.');
  const controlId = corpus.manifest.headlineComparison.controlTreatmentId;
  const marshalId = corpus.manifest.headlineComparison.marshalTreatmentId;
  const treatmentIds = config.selection?.treatmentIds ?? [controlId, marshalId];
  assert(treatmentIds.length === HEADLINE_TREATMENT_COUNT, 'Matched runner requires exactly two treatments.');
  assert(treatmentIds.includes(controlId) && treatmentIds.includes(marshalId), 'Headline runner must pair stock Codex and Codex+Marshal.');
  const treatments = treatmentIds.map((id) => {
    const treatment = corpus.treatments.find((item) => item.id === id);
    assert(treatment, `Unknown treatment: ${id}`);
    assert(treatment.headlineEligible === true, `Treatment ${id} is not headline eligible.`);
    assert(treatment.marshal.promptForced === false, `Treatment ${id} forces Marshal and cannot enter the headline comparison.`);
    return treatment;
  });
  const requestedCases = config.selection?.caseIds ? new Set(config.selection.caseIds) : undefined;
  const cases = corpus.cases.filter((item) => !requestedCases || requestedCases.has(item.id));
  assert(cases.length > 0, 'No cases selected.');
  if (requestedCases) {
    for (const id of requestedCases) assert(cases.some((item) => item.id === id), `Unknown case: ${id}`);
  }

  const pairs = [];
  for (const item of cases) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      const pairId = `${item.id}:r${repetition}`;
      const order = [...treatments].sort((left, right) =>
        stableOrder(config.seed, pairId, left.id) - stableOrder(config.seed, pairId, right.id),
      );
      pairs.push({
        pairId,
        caseId: item.id,
        family: item.family,
        repetition,
        pairSort: stableOrder(config.seed, 'pair', pairId),
        attempts: order.map((treatment, pairPosition) => ({
          attemptKey: `${item.id}/${treatment.id}/r${repetition}`,
          pairId,
          pairPosition: pairPosition + 1,
          caseId: item.id,
          family: item.family,
          repetition,
          treatmentId: treatment.id,
        })),
      });
    }
  }
  pairs.sort((left, right) => left.pairSort - right.pairSort || left.pairId.localeCompare(right.pairId));
  const attempts = pairs.flatMap((pair) => pair.attempts).map((attempt, index) => ({
    ...attempt,
    orderIndex: index + 1,
  }));
  return {
    schemaVersion: '1.0.0',
    runId: config.runId,
    seed: config.seed,
    repetitions: config.repetitions,
    corpusDigest: corpus.corpusDigest,
    configurationDigest: config.configurationDigest,
    authorizationBindingDigest: config.authorizationBindingDigest,
    fullCorpus: cases.length === corpus.cases.length,
    caseCount: cases.length,
    expectedAttempts: attempts.length,
    treatmentIds,
    attempts,
  };
}

export function attemptRequest(planAttempt, corpus, config, outputDirectory) {
  const item = corpus.cases.find((candidate) => candidate.id === planAttempt.caseId);
  const treatment = corpus.treatments.find((candidate) => candidate.id === planAttempt.treatmentId);
  assert(item && treatment, `Plan references unknown case or treatment: ${planAttempt.attemptKey}`);
  return {
    schemaVersion: '1.0.0',
    runId: config.runId,
    corpusDigest: corpus.corpusDigest,
    configurationDigest: config.configurationDigest,
    authorizationBindingDigest: config.authorizationBindingDigest,
    attempt: planAttempt,
    case: item,
    treatment,
    fixed: { ...config.fixed },
    inputs: Object.fromEntries(
      Object.entries(config.verifiedInputs).map(([name, input]) => [name, {
        path: input.path,
        sha256: input.sha256,
      }]),
    ),
    ...(config.adapter.kind === 'command' && config.adapter.driverOptions
      ? { driver: structuredClone(config.adapter.driverOptions) }
      : {}),
    outputDirectory,
  };
}

export function promptDigest(item) {
  return sha256(canonicalJson(item.phases.map((phase) => ({
    id: phase.id,
    taskBoundary: phase.taskBoundary,
    workspace: phase.workspace,
    fixture: phase.fixture ?? null,
    prompt: phase.prompt,
  }))));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function portablePath(value) {
  return value.split(sep).join('/');
}

export function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyInputFile(input, configRoot, name) {
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(configRoot, input.path);
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  assert(digest === input.sha256, `${name} digest mismatch for ${path}.`);
  return { path, sha256: digest };
}

function stableOrder(seed, ...parts) {
  return Number.parseInt(sha256([seed, ...parts].join('\u0000')).slice(0, 12), 16);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
