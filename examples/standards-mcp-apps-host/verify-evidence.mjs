#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_GATES = new Map([
  ['local-request-boundary', 'observed'],
  ['adaptive-outer-chrome-320px', 'observed'],
  ['inline-pixels', 'observed'],
  ['capability-action', 'observed'],
  ['theme-resize-safe-area', 'observed'],
  ['fullscreen', 'granted'],
  ['pip', 'unsupported'],
  ['remount', 'observed'],
  ['hydration-fallback', 'fallback'],
  ['complete-fallback', 'observed'],
  ['host-restart', 'observed'],
]);

export async function verifyStandardsHostEvidence(rootArgument) {
  if (!rootArgument || !isAbsolute(rootArgument)) throw new Error('Evidence root must be an absolute path.');
  const root = resolve(rootArgument);
  const errors = [];
  const report = await json(join(root, 'report.json'), errors, 'report.json');
  if (!report) return { ok: false, errors };
  if (report.schemaVersion !== '1.0.0'
    || report.evidenceClass !== 'automated-local-live-standards-host'
    || report.publicationClaimEligible !== false) {
    errors.push('report must be schema 1.0.0, automated local-live, and publication-ineligible');
  }
  if (!report.attemptId || !Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.completedAt))) {
    errors.push('report requires an attempt ID and valid timestamps');
  }
  if (report.browser?.interactionDriver !== 'chrome-devtools-protocol' || report.browser?.activation !== 'dom-click') {
    errors.push('report must disclose CDP DOM-click automation');
  }
  if (report.runtimePackage?.name !== '@marshal/agent-runtime-ui' || !isAbsolute(report.runtimePackage?.root ?? '')) {
    errors.push('report must identify an absolute installed @marshal/agent-runtime-ui root');
  }
  if (report.render?.beforeRestartCounters?.compileInvocations !== 1
    || report.render?.beforeRestartCounters?.renderInvocations !== 1
    || report.render?.beforeRestartCounters?.actionInvocations !== 2
    || report.render?.afterRestartCounters?.compileInvocations !== 0
    || report.render?.afterRestartCounters?.renderInvocations !== 0) {
    errors.push('render counters do not prove one original binding and zero restart compile/rebind calls');
  }
  if (report.state?.selection !== 'Direction B' || report.state?.revision !== 1) {
    errors.push('authoritative state was not restored after restart');
  }
  const gates = new Map((report.gates ?? []).map((gate) => [gate.id, gate]));
  if (gates.size !== EXPECTED_GATES.size) errors.push('gate count mismatch');
  for (const [id, expectedStatus] of EXPECTED_GATES) {
    const gate = gates.get(id);
    if (!gate || gate.status !== expectedStatus) errors.push(`${id} must report ${expectedStatus}`);
    if (gate?.screenshot && !/^screenshots\/[0-9]{2}-.+\.png$/.test(gate.screenshot)) {
      errors.push(`${id} has an invalid screenshot reference`);
    }
  }
  const hydrationMs = gates.get('hydration-fallback')?.timingMs;
  if (!Number.isFinite(hydrationMs) || hydrationMs >= 5_000) errors.push('hydration fallback must complete in under five seconds');
  const actionReceiptIds = gates.get('capability-action')?.receiptIds ?? [];
  if (actionReceiptIds.length !== 2 || new Set(actionReceiptIds).size !== 2) {
    errors.push('capability action requires distinct visible Save and Reopen dispatcher receipts');
  }

  const listed = new Set();
  for (const file of report.files ?? []) {
    if (!file?.path || listed.has(file.path)) {
      errors.push(`duplicate or missing file path ${file?.path ?? 'unknown'}`);
      continue;
    }
    listed.add(file.path);
    const path = join(root, file.path);
    try {
      const bytes = await readFile(path);
      if (bytes.length !== file.bytes) errors.push(`${file.path} byte count mismatch`);
      if (sha256(bytes) !== file.sha256) errors.push(`${file.path} hash mismatch`);
      if (file.path.endsWith('.png') && !png(bytes)) errors.push(`${file.path} is not a PNG`);
    } catch {
      errors.push(`${file.path} is missing`);
    }
  }
  for (const required of ['application.json', 'fallback.json', 'host-trace.jsonl', 'driver-trace.jsonl', 'receipts.jsonl', 'source-manifest.json']) {
    if (!listed.has(required)) errors.push(`report is missing ${required}`);
  }
  for (let index = 1; index <= 8; index += 1) {
    if (![...listed].some((path) => path.startsWith(`screenshots/0${index}-`) && path.endsWith('.png'))) {
      errors.push(`report is missing screenshot ${index}`);
    }
  }
  await nonEmptyJsonLines(join(root, 'host-trace.jsonl'), errors, 'host-trace.jsonl');
  await nonEmptyJsonLines(join(root, 'driver-trace.jsonl'), errors, 'driver-trace.jsonl');
  await nonEmptyJsonLines(join(root, 'receipts.jsonl'), errors, 'receipts.jsonl');
  return { ok: errors.length === 0, errors, report };
}

async function json(path, errors, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    errors.push(`${label} is missing or invalid JSON`);
    return undefined;
  }
}

async function nonEmptyJsonLines(path, errors, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new Error('empty');
    for (const line of lines) JSON.parse(line);
  } catch {
    errors.push(`${label} must be non-empty JSONL`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function png(value) {
  return value.length >= 24 && Buffer.from(value.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  try {
    const result = await verifyStandardsHostEvidence(process.argv[2]);
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Standards-host evidence passed: ${result.report.attemptId}`);
      console.log('Automated browser evidence remains publication-ineligible until uncut capture and independent review.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
