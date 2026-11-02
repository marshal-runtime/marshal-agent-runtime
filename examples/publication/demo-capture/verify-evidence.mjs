#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const captureRoot = dirname(fileURLToPath(import.meta.url));
const planText = await readFile(join(captureRoot, 'capture-plan.json'), 'utf8');
const plan = JSON.parse(planText);
const planHash = sha256(planText);

export async function verifyEvidenceBundle(evidenceArgument, options = {}) {
  if (!evidenceArgument) throw new Error('Usage: node verify-evidence.mjs /absolute/path/to/evidence [--level capture|publication] [--write-index]');
  const evidenceRoot = resolve(evidenceArgument);
  const level = options.level ?? 'capture';
  if (!['capture', 'publication'].includes(level)) throw new Error(`Unknown verification level: ${level}`);
  const errors = [];
  const attempts = [];

  try {
    if ((await stat(join(evidenceRoot, 'CAPTURE-BUNDLE-NOT-EVIDENCE.md'))).isFile()) {
      errors.push('CAPTURE-BUNDLE-NOT-EVIDENCE.md is still present; complete and review the capture before verification');
    }
  } catch {
    // Absence is required once the bundle is represented as evidence.
  }
  await compareSnapshot(evidenceRoot, errors);
  for (const demo of plan.demos) {
    const demoRoot = join(evidenceRoot, demo.id);
    const input = await readJson(join(demoRoot, 'capture-input.json'), errors, `${demo.id}: invalid capture-input.json`);
    validateInput(demo, input, errors);

    const required = level === 'publication'
      ? [...demo.requiredCaptureFiles, ...demo.requiredPublicationFiles]
      : demo.requiredCaptureFiles;
    for (const name of required) await requireNonEmptyFile(join(demoRoot, name), errors, `${demo.id}: missing or empty ${name}`);
    await validateMediaSignature(join(demoRoot, 'screen.webm'), 'webm', errors, `${demo.id}: screen.webm`);
    if (level === 'publication') {
      await validateMediaSignature(join(demoRoot, 'preview.gif'), 'gif', errors, `${demo.id}: preview.gif`);
      await validateMediaSignature(join(demoRoot, 'short.mp4'), 'mp4', errors, `${demo.id}: short.mp4`);
    }

    for (const name of demo.requiredCaptureFiles.filter((item) => item.endsWith('.json') && !['metadata.json', 'redaction-manifest.json'].includes(item))) {
      await readJson(join(demoRoot, name), errors, `${demo.id}: invalid ${name}`);
    }
    if (demo.prompts.length > 0) await validatePromptFile(demoRoot, demo, errors);

    const metadata = await readJson(join(demoRoot, 'metadata.json'), errors, `${demo.id}: invalid metadata.json`);
    validateMetadata(demo, input, metadata, errors);
    const recorder = await readJson(join(demoRoot, 'recorder.json'), errors, `${demo.id}: invalid recorder.json`);
    await validateRecorder(demoRoot, demo, recorder, errors);
    if ((demo.requiredHostGates ?? []).length > 0) {
      const gates = await readJson(join(demoRoot, 'host-gates.json'), errors, `${demo.id}: invalid host-gates.json`);
      validateHostGates(demo, gates, errors);
    }
    await validateJsonLines(join(demoRoot, 'trace.jsonl'), errors, `${demo.id}: trace.jsonl`);
    if (demo.requiredCaptureFiles.includes('receipts.jsonl')) {
      await validateJsonLines(join(demoRoot, 'receipts.jsonl'), errors, `${demo.id}: receipts.jsonl`);
    }
    const redaction = await readJson(join(demoRoot, 'redaction-manifest.json'), errors, `${demo.id}: invalid redaction-manifest.json`);
    validateRedaction(demo, redaction, errors);

    if (level === 'publication') {
      const review = await readJson(join(demoRoot, 'review.json'), errors, `${demo.id}: invalid review.json`);
      validateReview(demo, review, errors);
      const derivatives = await readJson(join(demoRoot, 'derivatives.json'), errors, `${demo.id}: invalid derivatives.json`);
      await validateDerivatives(demoRoot, demo, derivatives, errors);
    }

    attempts.push({
      demoId: demo.id,
      captureAttemptId: metadata?.captureAttemptId,
      startedAt: metadata?.startedAt,
      completedAt: metadata?.completedAt,
      files: await hashFiles(demoRoot, required, errors),
    });
  }

  const index = {
    schemaVersion: '1.0.0',
    verificationLevel: level,
    capturePlanVersion: plan.version,
    capturePlanSha256: planHash,
    attempts: attempts.sort((left, right) => left.demoId.localeCompare(right.demoId)),
  };
  if (errors.length === 0 && options.writeIndex) {
    await writeFile(join(evidenceRoot, 'evidence-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }
  return { ok: errors.length === 0, errors, index };
}

async function compareSnapshot(root, errors) {
  try {
    const snapshot = await readFile(join(root, 'capture-plan.snapshot.json'), 'utf8');
    if (sha256(snapshot) !== planHash) errors.push('capture-plan.snapshot.json does not match the current frozen capture plan');
  } catch {
    errors.push('missing capture-plan.snapshot.json; run prepare-evidence.mjs before capture');
  }
}

function validateInput(demo, input, errors) {
  if (!input) return;
  if (input.status !== 'planned-input-not-evidence') errors.push(`${demo.id}: capture input has an invalid status`);
  if (input.demoId !== demo.id) errors.push(`${demo.id}: capture input demoId mismatch`);
  if (input.capturePlanSha256 !== planHash) errors.push(`${demo.id}: capture input plan hash mismatch`);
  const hashes = demo.prompts.map((prompt) => sha256(prompt));
  if (JSON.stringify(input.prompts?.map((item) => item.sha256)) !== JSON.stringify(hashes)) {
    errors.push(`${demo.id}: prepared prompt hashes do not match the frozen plan`);
  }
}

function validateMetadata(demo, input, metadata, errors) {
  if (!metadata) return;
  const prefix = `${demo.id}: metadata`;
  if (metadata.schemaVersion !== '1.0.0') errors.push(`${prefix}.schemaVersion must be 1.0.0`);
  if (metadata.evidenceClass !== 'uncut-live') errors.push(`${prefix}.evidenceClass must be uncut-live`);
  if (metadata.demoId !== demo.id) errors.push(`${prefix}.demoId mismatch`);
  if (!stableId(metadata.captureAttemptId)) errors.push(`${prefix}.captureAttemptId is missing or a placeholder`);
  if (metadata.edited !== false) errors.push(`${prefix}.edited must be false for the uncut recording`);
  if (metadata.capturePlanSha256 !== planHash) errors.push(`${prefix}.capturePlanSha256 mismatch`);
  if (JSON.stringify(metadata.promptHashes) !== JSON.stringify(input?.prompts?.map((item) => item.sha256) ?? [])) {
    errors.push(`${prefix}.promptHashes do not match prepared inputs`);
  }
  const start = Date.parse(metadata.startedAt);
  const end = Date.parse(metadata.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) errors.push(`${prefix} requires ordered ISO timestamps`);
  for (const [path, value] of [
    ['host.name', metadata.host?.name], ['host.version', metadata.host?.version], ['host.operatingSystem', metadata.host?.operatingSystem],
    ['model.id', metadata.model?.id], ['model.reasoning', metadata.model?.reasoning],
    ['runtime.packageVersion', metadata.runtime?.packageVersion], ['runtime.protocolVersion', metadata.runtime?.protocolVersion],
    ['runtime.adapterVersion', metadata.runtime?.adapterVersion], ['runtime.pluginVersion', metadata.runtime?.pluginVersion],
    ['permissionProfile', metadata.permissionProfile],
  ]) {
    if (!stableId(value)) errors.push(`${prefix}.${path} is missing or a placeholder`);
  }
  if (metadata.recording?.uncutFile !== 'screen.webm'
    || metadata.recording?.recorderProvenance !== 'recorder.json'
    || metadata.recording?.continuous !== true
    || metadata.recording?.paused !== false
    || metadata.recording?.operatorDriven !== true
    || metadata.recording?.hostInteractionAutomated !== false
    || metadata.recording?.applicationRestartAutomated !== false) {
    errors.push(`${prefix}.recording must identify continuous operator-driven screen.webm plus recorder.json, with no claimed host automation`);
  }
}

async function validateRecorder(root, demo, value, errors) {
  if (!value) return;
  const prefix = `${demo.id}: recorder`;
  if (value.schemaVersion !== '1.0.0' || value.evidenceClass !== 'recorder-provenance-supporting-only') {
    errors.push(`${prefix} requires schema 1.0.0 and supporting-only evidence class`);
  }
  const start = Date.parse(value.startedAt);
  const end = Date.parse(value.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) errors.push(`${prefix} requires ordered ISO timestamps`);
  if (!['desktop', 'window'].includes(value.source)) errors.push(`${prefix}.source must be desktop or window`);
  if ((demo.requiredHostGates ?? []).includes('product-restart') && value.source !== 'desktop') {
    errors.push(`${prefix}.source must be desktop so recording can remain continuous while Codex is closed`);
  }
  if (!stableId(value.targetWindowTitle)) errors.push(`${prefix}.targetWindowTitle is missing`);
  if (value.output?.path !== 'screen.webm') errors.push(`${prefix}.output.path must be screen.webm`);
  const screen = join(root, 'screen.webm');
  try {
    const info = await stat(screen);
    if (value.output?.bytes !== info.size) errors.push(`${prefix}.output.bytes does not match screen.webm`);
    if (value.output?.sha256 !== await hashFile(screen)) errors.push(`${prefix}.output.sha256 does not match screen.webm`);
  } catch {
    // The required-file check already reports the missing recording.
  }
  if (!stableId(value.encoder?.executable) || !stableId(value.encoder?.version) || !Array.isArray(value.encoder?.arguments)) {
    errors.push(`${prefix}.encoder requires executable, version, and arguments`);
  }
  if (value.interactionDriver !== 'human' || value.applicationRestartAutomated !== false) {
    errors.push(`${prefix} must disclose human interaction and no automated application restart`);
  }
}

function validateHostGates(demo, value, errors) {
  if (!value) return;
  const prefix = `${demo.id}: host gates`;
  if (value.schemaVersion !== '1.0.0'
    || value.evidenceClass !== 'operator-observed-host-gates'
    || value.demoId !== demo.id
    || value.recording !== 'screen.webm'
    || value.interactionDriver !== 'human'
    || !stableId(value.operator)) {
    errors.push(`${prefix} requires matching demo/operator, screen.webm, human interaction, and the operator-observed evidence class`);
  }
  if (!Array.isArray(value.gates)) {
    errors.push(`${prefix}.gates must be an array`);
    return;
  }
  const allowedStatuses = new Set(['observed', 'granted', 'denied', 'fallback', 'unsupported', 'failed', 'not-applicable']);
  const expected = demo.requiredHostGates ?? [];
  const seen = new Set();
  for (const gate of value.gates) {
    if (!expected.includes(gate?.id) || seen.has(gate?.id)) {
      errors.push(`${prefix} contains an unknown or duplicate gate ${gate?.id ?? 'missing-id'}`);
      continue;
    }
    seen.add(gate.id);
    if (!allowedStatuses.has(gate.status)) errors.push(`${prefix}.${gate.id} has an invalid or unverified status`);
    if (!finiteRange(gate.sourceStartMs, gate.sourceEndMs)) errors.push(`${prefix}.${gate.id} requires a valid uncut recording range`);
    if (!Array.isArray(gate.traceRefs) || !Array.isArray(gate.receiptIds) || !Array.isArray(gate.notes)) {
      errors.push(`${prefix}.${gate.id} requires traceRefs, receiptIds, and notes arrays`);
    }
    if (requiresMachineReference(gate.id) && (gate.traceRefs?.length ?? 0) + (gate.receiptIds?.length ?? 0) === 0) {
      errors.push(`${prefix}.${gate.id} requires a trace or receipt reference in addition to the video range`);
    }
  }
  for (const id of expected) if (!seen.has(id)) errors.push(`${prefix} is missing required gate ${id}`);
}

function requiresMachineReference(id) {
  return /action|fullscreen|pip|same-render|no-recompile|restored-state|selected-state/.test(id);
}

function validateRedaction(demo, value, errors) {
  if (!value) return;
  if (value.demoId !== demo.id || value.reviewed !== true || !stableId(value.reviewer)) {
    errors.push(`${demo.id}: redaction manifest requires matching demoId, reviewed=true, and reviewer`);
  }
  if (!Array.isArray(value.rules) || !Array.isArray(value.redactions)) {
    errors.push(`${demo.id}: redaction manifest requires rules and redactions arrays`);
  }
  if (value.traceIntegrityPreserved !== true) errors.push(`${demo.id}: redaction manifest must confirm traceIntegrityPreserved`);
}

function validateReview(demo, value, errors) {
  if (!value) return;
  if (value.demoId !== demo.id || !stableId(value.reviewer)) errors.push(`${demo.id}: review requires matching demoId and reviewer`);
  for (const key of ['continuityInspected', 'hostPixelsInspected', 'traceReceiptCorrespondenceInspected', 'shortEditFairToUncut']) {
    if (value[key] !== true) errors.push(`${demo.id}: review.${key} must be true`);
  }
  if (!Array.isArray(value.unsupportedFeatures)) errors.push(`${demo.id}: review.unsupportedFeatures must be an array`);
}

async function validateDerivatives(root, demo, value, errors) {
  if (!value) return;
  if (value.demoId !== demo.id || value.source?.path !== 'screen.webm') {
    errors.push(`${demo.id}: derivatives must identify the matching demo and screen.webm source`);
    return;
  }
  if (!stableId(value.encoder?.name) || !stableId(value.encoder?.version) || !Array.isArray(value.encoder?.commands) || value.encoder.commands.length === 0) {
    errors.push(`${demo.id}: derivatives must record encoder name, version, and exact commands`);
  }
  const sourceHash = await hashFile(join(root, 'screen.webm'));
  if (value.source.sha256 !== sourceHash) errors.push(`${demo.id}: derivatives source hash does not match screen.webm`);
  for (const name of ['preview.gif', 'short.mp4']) {
    const output = value.outputs?.find((item) => item.path === name);
    if (!output || output.sha256 !== await hashFile(join(root, name))) errors.push(`${demo.id}: derivatives hash missing or wrong for ${name}`);
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0 || value.edits.some((edit) => !finiteRange(edit?.sourceStartMs, edit?.sourceEndMs))) {
    errors.push(`${demo.id}: derivatives must disclose at least one valid uncut source range`);
  }
}

async function validateJsonLines(path, errors, label) {
  try {
    const content = await readFile(path, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new Error('empty');
    for (const line of lines) JSON.parse(line);
  } catch {
    errors.push(`${label} must be non-empty JSONL`);
  }
}

async function validatePromptFile(root, demo, errors) {
  try {
    if (demo.frozenPrompt) {
      if (!stableId(demo.frozenPrompt.source) || !/^[a-f0-9]{64}$/.test(demo.frozenPrompt.sha256 ?? '')) {
        errors.push(`${demo.id}: frozen prompt provenance is invalid`);
      } else if (demo.prompts.length !== 1 || sha256(demo.prompts[0]) !== demo.frozenPrompt.sha256) {
        errors.push(`${demo.id}: capture plan does not match its canonical frozen prompt`);
      }
    }
    const expected = `${demo.prompts.join('\n\n--- next fresh task ---\n\n')}\n`;
    const actual = await readFile(join(root, 'prompt.txt'), 'utf8');
    if (actual !== expected) errors.push(`${demo.id}: prompt.txt does not match the frozen prompt text`);
  } catch {
    errors.push(`${demo.id}: prompt.txt is unavailable`);
  }
}

async function readJson(path, errors, message) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    errors.push(message);
    return undefined;
  }
}

async function requireNonEmptyFile(path, errors, message) {
  try {
    if (!(await stat(path)).isFile() || (await stat(path)).size === 0) errors.push(message);
  } catch {
    errors.push(message);
  }
}

async function validateMediaSignature(path, kind, errors, label) {
  try {
    const bytes = await readFile(path);
    if (!validMediaSignature(bytes, kind)) errors.push(`${label} does not have a valid ${kind.toUpperCase()} file signature`);
  } catch {
    // The required-file check already reports missing files.
  }
}

export function validMediaSignature(bytes, kind) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return false;
  if (kind === 'webm') {
    const header = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096)));
    return bytes.length >= 16
      && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      && header.includes(Buffer.from('webm'));
  }
  if (kind === 'gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'));
  if (kind === 'mp4') return bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp';
  return false;
}

async function hashFiles(root, names, errors) {
  const results = [];
  for (const name of [...names].sort()) {
    try {
      const path = join(root, name);
      const info = await stat(path);
      results.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: info.size, sha256: await hashFile(path) });
    } catch {
      // Missing files are already reported as validation errors.
    }
  }
  return results;
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

function stableId(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE|PLACEHOLDER/i.test(value);
}

function finiteRange(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const arguments_ = process.argv.slice(2);
  const evidenceRoot = arguments_.find((value) => !value.startsWith('--'));
  const levelIndex = arguments_.indexOf('--level');
  const level = levelIndex >= 0 ? arguments_[levelIndex + 1] : 'capture';
  try {
    const result = await verifyEvidenceBundle(evidenceRoot, { level, writeIndex: arguments_.includes('--write-index') });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Evidence set passed ${level} structural verification.`);
      console.log(`Capture plan sha256:${planHash}`);
      console.log('Structural verification is not a substitute for independent review.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
