#!/usr/bin/env node
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAdapterAttempt } from './adapters.mjs';
import {
  attemptRequest,
  createMatchedPlan,
  loadCorpus,
  loadRunConfig,
} from './core.mjs';
import {
  appendEvidenceRecord,
  buildBlindReviewBundle,
  captureAttemptRecord,
  initializeRunDirectory,
  prepareAttemptDirectory,
  readEvidenceRecords,
  verifyEvidenceFiles,
} from './evidence.mjs';
import { buildEvaluationReport, renderMarkdownReport } from './report-lib.mjs';

export async function runEvaluation(options) {
  const config = await loadRunConfig(options.config);
  const corpus = await loadCorpus(config.corpusRoot);
  const plan = createMatchedPlan(corpus, config);
  const configuredOutput = config.output
    ? resolve(config.configRoot, config.output)
    : resolve(config.configRoot, 'runs', config.runId);
  const runDirectory = resolve(options.output ?? configuredOutput);
  const dryRun = options.dryRun === true || config.adapter.kind === 'dry-run';
  const run = await initializeRunDirectory(runDirectory, plan, config, {
    resume: options.resume === true,
    dryRun,
  });
  const writerLock = await acquireRunWriterLock(run.root, plan);
  try {
    if (dryRun) {
      await writeFile(
        resolve(run.root, 'DRY_RUN_ONLY.txt'),
        'This directory contains a deterministic execution plan only. No Codex or Marshal attempt was run, and it is not evaluation evidence.\n',
        'utf8',
      );
      return { runDirectory: run.root, plan, records: [], dryRun: true };
    }

    const existing = await readEvidenceRecords(run.evidencePath);
    const completed = new Set();
    for (const record of existing) {
      if (completed.has(record.attemptKey)) throw new Error(`Duplicate existing attempt: ${record.attemptKey}`);
      if (record.configurationDigest !== plan.configurationDigest) throw new Error(`Existing attempt ${record.attemptKey} has a different configuration digest.`);
      if (record.environment.corpusDigest !== plan.corpusDigest) throw new Error(`Existing attempt ${record.attemptKey} has a different corpus digest.`);
      await verifyEvidenceFiles(run.root, record);
      completed.add(record.attemptKey);
    }

    for (const attempt of plan.attempts) {
      if (completed.has(attempt.attemptKey)) continue;
      const item = corpus.cases.find((candidate) => candidate.id === attempt.caseId);
      const attemptDirectory = await prepareAttemptDirectory(run.root, attempt);
      const request = attemptRequest(attempt, corpus, config, attemptDirectory);
      const startedAt = new Date().toISOString();
      let result;
      try {
        result = await runAdapterAttempt(request, config);
      } catch (error) {
        result = {
          evidenceClass: config.adapter.kind === 'fixture' ? 'fixture' : 'unavailable',
          status: 'error',
          excluded: false,
          errorCategory: 'runner-adapter-error',
          errorMessage: error instanceof Error ? error.message : String(error),
          finalOutput: '',
          phaseOutputs: [],
          trace: [{ event: 'runner-adapter-error', message: error instanceof Error ? error.message : String(error) }],
          generatedFiles: [],
          permissions: [],
          receipts: [],
          observedTools: [],
          uiEvidence: [],
          assertionObservations: {},
          timings: {},
          availability: {
            commandDriver: {
              status: 'unavailable',
              reason: 'The command adapter threw before returning a protocol result.',
            },
          },
          wallTimeMs: 0,
          toolCalls: 0,
          retries: config.fixed.maxRetries,
          tokens: { input: 0, output: 0, cached: 0 },
        };
      }
      const completedAt = new Date().toISOString();
      const record = await captureAttemptRecord({
        run,
        plan,
        attempt,
        item,
        config,
        adapterResult: result,
        attemptDirectory,
        startedAt,
        completedAt,
      });
      await appendEvidenceRecord(run.evidencePath, record);
      completed.add(attempt.attemptKey);
    }

    const records = await readEvidenceRecords(run.evidencePath);
    await buildBlindReviewBundle(run.root, corpus, records);
    const report = buildEvaluationReport({ corpus, plan, records });
    await writeReportFiles(run.root, report);
    return { runDirectory: run.root, plan, records, report, dryRun: false };
  } finally {
    await writerLock.release();
  }
}

async function acquireRunWriterLock(runRoot, plan) {
  const path = resolve(runRoot, '.writer.lock');
  const recoveryPath = resolve(runRoot, '.writer.lock.recovery');
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      handle = await recoverStaleWriterLock({ path, recoveryPath, runRoot });
    } else {
      throw error;
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: '1.0.0',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runId: plan.runId,
      configurationDigest: plan.configurationDigest,
    }, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  return {
    async release() {
      await handle.close();
      await rm(path, { force: true });
    },
  };
}

async function recoverStaleWriterLock({ path, recoveryPath, runRoot }) {
  let recoveryHandle;
  try {
    recoveryHandle = await open(recoveryPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Another evaluation writer owns or is recovering this run directory: ${runRoot}`);
    }
    throw error;
  }

  try {
    const owner = await readWriterLock(path);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || processIsAlive(owner.pid)) {
      throw new Error(`Another evaluation writer owns this run directory: ${runRoot}`);
    }
    await rm(path, { force: true });
    try {
      return await open(path, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Another evaluation writer acquired this run directory during stale-lock recovery: ${runRoot}`);
      }
      throw error;
    }
  } finally {
    await recoveryHandle.close();
    await rm(recoveryPath, { force: true });
  }
}

async function readWriterLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function writeReportFiles(runRoot, report) {
  await mkdir(runRoot, { recursive: true });
  await writeFile(resolve(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(resolve(runRoot, 'report.md'), renderMarkdownReport(report), 'utf8');
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') options.config = argv[++index];
    else if (value === '--output') options.output = argv[++index];
    else if (value === '--resume') options.resume = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/evals/run.mjs --config <run-config.json> [--output <directory>] [--resume] [--dry-run]\n\n`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      if (!options.config) throw new Error('--config is required.');
      const result = await runEvaluation(options);
      process.stdout.write(result.dryRun
        ? `Wrote dry-run plan for ${result.plan.expectedAttempts} attempts to ${result.runDirectory}. No evaluation was executed.\n`
        : `Published ${result.records.length}/${result.plan.expectedAttempts} attempts to ${result.runDirectory}. Release claim eligible: ${result.report.releaseClaim.eligible}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
