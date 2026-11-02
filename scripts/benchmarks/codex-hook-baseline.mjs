#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  hookContextExcerpt,
  hookOutputHasContext,
} from './codex-hook-baseline-lib.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hookCli = join(repositoryRoot, 'packages', 'agent-runtime-codex', 'dist', 'hookCli.js');
const MAX_OUTPUT_BYTES = 1024 * 1024;

await main();

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'marshal-codex-hook-baseline-'));
  try {
    try {
      await access(hookCli);
    } catch {
      process.stdout.write(`${JSON.stringify({
        benchmark: 'marshal-codex-hook-baseline',
        version: 1,
        ok: false,
        diagnostics: [{
          code: 'BUILT_HOOK_CLI_MISSING',
          message: `Built Codex hook CLI not found at ${hookCli}. Run pnpm build first.`,
        }],
      }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    const environment = {
      ...process.env,
      MARSHAL_RUNTIME_MEMORY_DB: join(temporaryRoot, 'shared-memory', 'memory.sqlite'),
    };
    const invocations = [];
    const scenarios = [];

    for (let index = 0; index < options.samples; index += 1) {
      const sourceWorkspace = join(temporaryRoot, 'workspaces', `source-${index}`);
      const targetWorkspace = join(temporaryRoot, 'workspaces', `target-${index}`);
      await Promise.all([
        mkdir(sourceWorkspace, { recursive: true }),
        mkdir(targetWorkspace, { recursive: true }),
      ]);
      const marker = `marshal-hook-baseline-${index}-${process.pid}`;
      const remembered = `${marker} requires preserving the original incident service label`;
      const sourceSession = `hook-source-task-${index}`;
      const targetSession = `hook-target-task-${index}`;

      const sourceStart = await runStage('source_session_start', index, {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: sourceSession,
        cwd: sourceWorkspace,
      }, environment, options.timeoutMs, invocations);
      const remember = await runStage('explicit_remember', index, {
        hook_event_name: 'UserPromptSubmit',
        session_id: sourceSession,
        cwd: sourceWorkspace,
        prompt: `remember that ${remembered}`,
      }, environment, options.timeoutMs, invocations);
      const targetStart = await runStage('new_task_session_start', index, {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: targetSession,
        cwd: targetWorkspace,
      }, environment, options.timeoutMs, invocations);
      const recall = await runStage('new_task_cross_workspace_recall', index, {
        hook_event_name: 'UserPromptSubmit',
        session_id: targetSession,
        cwd: targetWorkspace,
        prompt: `What incident instruction is associated with ${marker}?`,
      }, environment, options.timeoutMs, invocations);
      const warmishRecall = await runStage('warmish_repeat_recall', index, {
        hook_event_name: 'UserPromptSubmit',
        session_id: targetSession,
        cwd: targetWorkspace,
        prompt: `Repeat the saved service-label instruction for ${marker}.`,
      }, environment, options.timeoutMs, invocations);

      scenarios.push({
        index,
        sourceBriefing: hookOutputHasContext(sourceStart, 'Marshal Runtime capability briefing'),
        writeReceipt:
          hookOutputHasContext(remember, 'Marshal automatic memory write receipt:') &&
          hookOutputHasContext(remember, remembered),
        targetBriefing: hookOutputHasContext(targetStart, 'Marshal Runtime capability briefing'),
        newTaskRecall:
          hookOutputHasContext(recall, 'automatically recalled relevant durable memory') &&
          hookOutputHasContext(recall, remembered),
        warmishRecall:
          hookOutputHasContext(warmishRecall, 'automatically recalled relevant durable memory') &&
          hookOutputHasContext(warmishRecall, remembered),
        observedContext: {
          remember: hookContextExcerpt(remember),
          newTaskRecall: hookContextExcerpt(recall),
          warmishRecall: hookContextExcerpt(warmishRecall),
        },
      });
    }

    const report = createReport(options, invocations, scenarios);
    if (!options.jsonOnly) printSummary(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (Object.values(report.reliability).some((value) => value !== 1)) process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runStage(stage, sample, payload, environment, timeoutMs, invocations) {
  const invocation = await invokeHook(payload, environment, timeoutMs);
  const tagged = { ...invocation, stage, sample, durationMs: rounded(invocation.durationMs) };
  invocations.push(tagged);
  return tagged;
}

async function invokeHook(payload, environment, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolveInvocation) => {
    const child = spawn(process.execPath, [hookCli], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const capture = (target) => (chunk) => {
      const buffer = Buffer.from(chunk);
      capturedBytes += buffer.length;
      if (capturedBytes <= MAX_OUTPUT_BYTES) target.push(buffer);
      else {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', (error) => finish({ startError: error }));
    child.once('close', (exitCode) => finish({ exitCode }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);

    function finish({ exitCode = null, startError } = {}) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      let output;
      let parseError;
      try {
        output = JSON.parse(stdoutText);
      } catch (error) {
        parseError = startError
          ? `Subprocess could not be started: ${startError.message}`
          : `Hook stdout was not one JSON object: ${error instanceof Error ? error.message : String(error)}`;
      }
      resolveInvocation({
        ok:
          !timedOut &&
          !outputLimitExceeded &&
          startError === undefined &&
          exitCode === 0 &&
          output !== undefined,
        exitCode,
        timedOut,
        outputLimitExceeded,
        durationMs: performance.now() - startedAt,
        stderr: stderrText.slice(-4_000),
        parseError,
        output,
      });
    }
  });
}

function createReport(options, invocations, scenarios) {
  const successfulProcesses = invocations.filter((entry) => entry.ok).length;
  return {
    benchmark: 'marshal-codex-hook-baseline',
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    configuration: options,
    interpretation: {
      cold: 'The first hook invocation uses a fresh Node process and empty temporary runtime state.',
      warmish:
        'Every later invocation is still a fresh process; only OS caches and persisted runtime/SQLite state may be warm.',
    },
    latencyMs: {
      firstColdProcess: rounded(invocations[0]?.durationMs ?? 0),
      laterWarmishProcesses: summarize(invocations.slice(1).map((entry) => entry.durationMs)),
      sourceSessionStart: summarize(stageDurations(invocations, 'source_session_start')),
      explicitRemember: summarize(stageDurations(invocations, 'explicit_remember')),
      newTaskSessionStart: summarize(stageDurations(invocations, 'new_task_session_start')),
      newTaskCrossWorkspaceRecall: summarize(stageDurations(invocations, 'new_task_cross_workspace_recall')),
      warmishRepeatRecall: summarize(stageDurations(invocations, 'warmish_repeat_recall')),
    },
    reliability: {
      subprocessSuccessRate: rate(successfulProcesses, invocations.length),
      sourceBriefingRate: scenarioRate(scenarios, 'sourceBriefing'),
      explicitRememberReceiptRate: scenarioRate(scenarios, 'writeReceipt'),
      targetBriefingRate: scenarioRate(scenarios, 'targetBriefing'),
      newTaskCrossWorkspaceRecallRate: scenarioRate(scenarios, 'newTaskRecall'),
      warmishRepeatRecallRate: scenarioRate(scenarios, 'warmishRecall'),
    },
    invocations: invocations.map(({ output: _output, ...entry }) => entry),
    diagnostics: [
      ...invocations.filter((entry) => !entry.ok).map((entry) => ({
        stage: entry.stage,
        sample: entry.sample,
        code: entry.timedOut
          ? 'HOOK_TIMEOUT'
          : entry.outputLimitExceeded
            ? 'HOOK_OUTPUT_LIMIT'
            : 'HOOK_PROCESS_FAILED',
        exitCode: entry.exitCode,
        stderr: entry.stderr,
        parseError: entry.parseError,
      })),
      ...semanticDiagnostics(scenarios),
    ],
  };
}

function semanticDiagnostics(scenarios) {
  const fields = [
    ['sourceBriefing', 'SOURCE_BRIEFING_MISSING'],
    ['writeReceipt', 'EXPLICIT_REMEMBER_RECEIPT_MISSING'],
    ['targetBriefing', 'TARGET_BRIEFING_MISSING'],
    ['newTaskRecall', 'NEW_TASK_CROSS_WORKSPACE_RECALL_MISSING'],
    ['warmishRecall', 'WARMISH_REPEAT_RECALL_MISSING'],
  ];
  return scenarios.flatMap((scenario) => fields
    .filter(([field]) => !scenario[field])
    .map(([field, code]) => ({
      code,
      sample: scenario.index,
      observedContext: field === 'writeReceipt'
        ? scenario.observedContext.remember
        : field === 'newTaskRecall'
          ? scenario.observedContext.newTaskRecall
          : field === 'warmishRecall'
            ? scenario.observedContext.warmishRecall
            : null,
    })));
}

function stageDurations(invocations, stage) {
  return invocations.filter((entry) => entry.stage === stage).map((entry) => entry.durationMs);
}

function scenarioRate(scenarios, key) {
  return rate(scenarios.filter((scenario) => scenario[key]).length, scenarios.length);
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: rounded(sorted[0] ?? 0),
    mean: rounded(sorted.length === 0 ? 0 : total / sorted.length),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}

function rate(value, total) {
  return total === 0 ? 0 : rounded(value / total, 6);
}

function rounded(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function parseArguments(args) {
  const parsed = { samples: 5, timeoutMs: 30_000, jsonOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      parsed.jsonOnly = true;
      continue;
    }
    if (argument === '--samples' || argument === '--timeout-ms') {
      const value = Number.parseInt(args[index + 1] ?? '', 10);
      const maximum = argument === '--samples' ? 100 : 300_000;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${argument} must be an integer between 1 and ${maximum}.`);
      }
      if (argument === '--samples') parsed.samples = value;
      else parsed.timeoutMs = value;
      index += 1;
      continue;
    }
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node scripts/benchmarks/codex-hook-baseline.mjs [--samples N] [--timeout-ms N] [--json]\n',
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function printSummary(report) {
  process.stdout.write('Marshal Codex hook baseline\n');
  process.stdout.write(
    `First cold process: ${report.latencyMs.firstColdProcess} ms; later process p95: ${report.latencyMs.laterWarmishProcesses.p95} ms\n`,
  );
  process.stdout.write(
    `Remember p95: ${report.latencyMs.explicitRemember.p95} ms; new-task recall p95: ${report.latencyMs.newTaskCrossWorkspaceRecall.p95} ms\n`,
  );
  process.stdout.write(
    `Remember receipts: ${(report.reliability.explicitRememberReceiptRate * 100).toFixed(1)}%; cross-workspace recall: ${(report.reliability.newTaskCrossWorkspaceRecallRate * 100).toFixed(1)}%\n`,
  );
}
