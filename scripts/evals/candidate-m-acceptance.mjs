#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CANDIDATE_M_PLAN,
  evaluateCandidateMEvidence,
  loadCandidateMPlan,
  validateCandidateMPlan,
} from './candidate-m-acceptance-lib.mjs';

export async function runCandidateMAcceptance({ planPath, evidencePath } = {}) {
  const plan = await loadCandidateMPlan(planPath ?? DEFAULT_CANDIDATE_M_PLAN);
  const validatedPlan = await validateCandidateMPlan(plan);
  if (!evidencePath) return { mode: 'plan-validation', passed: true, plan: validatedPlan };
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
  return { mode: 'evidence-validation', ...evaluateCandidateMEvidence(plan, evidence) };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--plan') result.planPath = requiredValue(argv[++index], '--plan');
    else if (value === '--evidence') result.evidencePath = requiredValue(argv[++index], '--evidence');
    else if (value === '--json') result.json = true;
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function requiredValue(value, option) {
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a path.`);
  return value;
}

function usage() {
  return [
    'Usage: node scripts/evals/candidate-m-acceptance.mjs [options]',
    '',
    '  --plan <path>      Candidate M acceptance plan (defaults to the checked-in plan)',
    '  --evidence <path>  Validate one post-restart live evidence JSON document',
    '  --json             Print the complete machine-readable result',
    '  --help             Show this help',
    '',
    'With no --evidence argument, the command validates frozen prompt bytes and plan invariants only.',
  ].join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const result = await runCandidateMAcceptance(options);
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.mode === 'plan-validation') {
        process.stdout.write(`Candidate M plan valid: ${result.plan.promptCount} frozen prompts.\n`);
      } else {
        const passed = result.checks.filter((check) => check.passed).length;
        process.stdout.write(`Candidate M acceptance: ${result.passed ? 'PASS' : 'FAIL'} (${passed}/${result.checks.length} checks).\n`);
        for (const check of result.checks.filter((check) => !check.passed)) {
          process.stdout.write(`- ${check.id}: ${check.detail}\n`);
        }
      }
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
