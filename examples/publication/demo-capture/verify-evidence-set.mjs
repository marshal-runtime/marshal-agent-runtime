#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyEvidenceBundle } from './verify-evidence.mjs';

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(captureRoot, '..', '..', '..');
const allowedOutcomes = new Set(['succeeded', 'failed', 'interrupted', 'unsupported']);

/** Verify every external bundle named by a frozen all-attempt ledger and emit one deterministic aggregate index. */
export async function verifyEvidenceSet(rootArgument, options = {}) {
  if (!rootArgument || !isAbsolute(rootArgument)) throw new Error('Evidence set root must be an absolute path.');
  const root = resolve(rootArgument);
  if (inside(root, repositoryRoot)) throw new Error('Evidence sets must live outside the source repository.');
  const level = options.level ?? 'capture';
  if (!['capture', 'publication'].includes(level)) throw new Error(`Unknown verification level: ${level}`);
  const manifestName = safeSegment(options.manifestName ?? 'all-attempts.json');
  if (!manifestName) throw new Error('Attempt manifest must be one plain file name.');
  const manifestPath = join(root, manifestName);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const errors = validateLedgerShape(manifest);
  const entries = await readdir(root, { withFileTypes: true });
  const actualBundleNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expectedBundleNames = [...new Set((manifest.attempts ?? []).map((item) => item.bundle))].sort();
  if (JSON.stringify(actualBundleNames) !== JSON.stringify(expectedBundleNames)) {
    errors.push(`Bundle directories do not exactly match the all-attempt ledger: actual=${actualBundleNames.join(',')} expected=${expectedBundleNames.join(',')}`);
  }

  const bundleResults = [];
  for (const bundle of expectedBundleNames) {
    if (!safeSegment(bundle)) continue;
    try {
      const verification = await verifyEvidenceBundle(join(root, bundle), { level, writeIndex: false });
      bundleResults.push({ bundle, verification });
      errors.push(...verification.errors.map((error) => `${bundle}: ${error}`));
    } catch (error) {
      errors.push(`${bundle}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const reconciliation = reconcileAttemptLedger(manifest, bundleResults);
  errors.push(...reconciliation.errors);
  const index = {
    schemaVersion: '1.0.0',
    evidenceClass: 'aggregate-structural-index',
    evidenceSetId: manifest.evidenceSetId,
    verificationLevel: level,
    allAttemptsManifest: {
      path: manifestName,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
      frozenAt: manifest.frozenAt,
    },
    attempts: reconciliation.attempts,
    caveats: [
      'Every attempt listed by the frozen ledger is structurally verified and indexed, including failed and interrupted outcomes.',
      'This verifier rejects unlisted bundle directories but cannot detect a run the operator never preserved under this evidence-set root.',
      'Structural verification does not convert a failed, interrupted, denied, fallback, or unsupported outcome into success.',
    ],
  };
  if (errors.length === 0 && options.writeIndex) {
    await writeFile(join(root, 'evidence-set-index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'w' });
  }
  return { ok: errors.length === 0, errors, index };
}

export function reconcileAttemptLedger(manifest, bundleResults) {
  const errors = [];
  const actual = new Map();
  for (const { bundle, verification } of bundleResults) {
    for (const attempt of verification.index?.attempts ?? []) {
      const key = `${bundle}\u0000${attempt.demoId}`;
      if (actual.has(key)) errors.push(`Duplicate verified attempt for ${bundle}/${attempt.demoId}`);
      actual.set(key, attempt);
    }
  }
  const attempts = [];
  const seenIds = new Set();
  for (const item of manifest.attempts ?? []) {
    if (!item || !safeSegment(item.bundle) || !stableId(item.demoId) || !stableId(item.captureAttemptId)) continue;
    const key = `${item.bundle}\u0000${item.demoId}`;
    const verified = actual.get(key);
    if (!verified) {
      errors.push(`Ledger attempt ${item.bundle}/${item.demoId} has no verified bundle entry`);
      continue;
    }
    actual.delete(key);
    if (verified.captureAttemptId !== item.captureAttemptId) {
      errors.push(`Ledger captureAttemptId mismatch for ${item.bundle}/${item.demoId}`);
    }
    if (seenIds.has(item.captureAttemptId)) errors.push(`Duplicate captureAttemptId in ledger: ${item.captureAttemptId}`);
    seenIds.add(item.captureAttemptId);
    attempts.push({
      bundle: item.bundle,
      demoId: item.demoId,
      captureAttemptId: item.captureAttemptId,
      outcome: item.outcome,
      notes: item.notes,
      startedAt: verified.startedAt,
      completedAt: verified.completedAt,
      files: verified.files,
    });
  }
  for (const key of actual.keys()) {
    const [bundle, demoId] = key.split('\u0000');
    errors.push(`Verified bundle attempt is absent from all-attempt ledger: ${bundle}/${demoId}`);
  }
  attempts.sort((left, right) => left.bundle.localeCompare(right.bundle) || left.demoId.localeCompare(right.demoId));
  return { errors, attempts };
}

function validateLedgerShape(value) {
  const errors = [];
  if (!value || value.schemaVersion !== '1.0.0' || !stableId(value.evidenceSetId) || !validIso(value.frozenAt) || !Array.isArray(value.attempts) || value.attempts.length === 0) {
    errors.push('all-attempts.json requires schemaVersion 1.0.0, evidenceSetId, frozenAt, and a non-empty attempts array');
    return errors;
  }
  const keys = new Set();
  for (const [index, item] of value.attempts.entries()) {
    if (!item || !safeSegment(item.bundle) || !stableId(item.demoId) || !stableId(item.captureAttemptId)
      || !allowedOutcomes.has(item.outcome) || !Array.isArray(item.notes)) {
      errors.push(`all-attempts.json entry ${index} requires a safe bundle, demoId, captureAttemptId, declared outcome, and notes array`);
      continue;
    }
    const key = `${item.bundle}\u0000${item.demoId}`;
    if (keys.has(key)) errors.push(`Duplicate bundle/demo ledger entry: ${item.bundle}/${item.demoId}`);
    keys.add(key);
  }
  return errors;
}

function safeSegment(value) {
  return stableId(value) && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

function stableId(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE|PLACEHOLDER/i.test(value);
}

function validIso(value) {
  return stableId(value) && Number.isFinite(Date.parse(value));
}

function inside(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const args = process.argv.slice(2);
  const root = args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--level' && args[index - 1] !== '--manifest');
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  try {
    const result = await verifyEvidenceSet(root, {
      level: value('--level', 'capture'),
      manifestName: value('--manifest', 'all-attempts.json'),
      writeIndex: args.includes('--write-index'),
    });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Evidence set passed ${result.index.verificationLevel} structural verification for ${result.index.attempts.length} attempts.`);
      console.log('The all-attempt ledger is an operator preservation boundary, not proof that no external run was omitted.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
