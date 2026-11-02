#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCorpus } from './core.mjs';
import { loadHumanGrades, readEvidenceRecords } from './evidence.mjs';
import { buildEvaluationReport, renderMarkdownReport } from './report-lib.mjs';

export async function regenerateReport(options) {
  const runRoot = resolve(options.run);
  const plan = JSON.parse(await readFile(join(runRoot, 'plan.json'), 'utf8'));
  const corpus = await loadCorpus(options.corpus ?? 'docs/evals/v1');
  if (corpus.corpusDigest !== plan.corpusDigest) throw new Error('Corpus digest does not match the run plan.');
  const records = await readEvidenceRecords(join(runRoot, 'evidence.jsonl'));
  const humanGrades = await loadHumanGrades(options.humanGrades);
  const report = buildEvaluationReport({ corpus, plan, records, humanGrades });
  await writeFile(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(runRoot, 'report.md'), renderMarkdownReport(report), 'utf8');
  return report;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--run') options.run = argv[++index];
    else if (value === '--corpus') options.corpus = argv[++index];
    else if (value === '--human-grades') options.humanGrades = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: node scripts/evals/report.mjs --run <run-directory> [--corpus docs/evals/v1] [--human-grades grades.jsonl]\n');
    } else {
      if (!options.run) throw new Error('--run is required.');
      const report = await regenerateReport(options);
      process.stdout.write(`Regenerated report for ${report.attempts.length} attempts. Release claim eligible: ${report.releaseClaim.eligible}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
