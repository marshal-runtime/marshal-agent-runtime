import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assessWindowsJobBoundary,
  measureWindowsJobBoundary,
  probeNativeJobHost,
  validateWindowsJobProfile,
  WINDOWS_JOB_LIMITATIONS,
  WINDOWS_JOB_REQUIRED_COVERAGE,
} from '../security/windows-job-object-launcher.mjs';
import { validateConfinementAttestation, validateConfinementProfile } from '../security/confinement-contract.mjs';

const launcherFile = resolve('scripts/evals/security/windows-job-object-launcher.mjs');
const helperFile = resolve('scripts/evals/security/windows-job-object-host.ps1');
const profileFile = resolve('scripts/evals/security/profiles/windows-job-object-descendants.json');
const targetFile = resolve('scripts/evals/__tests__/fixtures/windows-job-object-target.mjs');
const WINDOWS_PLATFORM = 'win32-x64';

test('Job Object profile discloses every release-contract limitation and cannot pass the release validator', async () => {
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  assert.equal(validateWindowsJobProfile(profile, WINDOWS_PLATFORM), profile);
  assert.deepEqual([...profile.limitations].sort(), [...WINDOWS_JOB_LIMITATIONS].sort());
  assert.deepEqual([...profile.coverage].sort(), [...WINDOWS_JOB_REQUIRED_COVERAGE].sort());
  assert.throws(() => validateConfinementProfile(profile, WINDOWS_PLATFORM), /deny-by-default/);

  for (const mutation of [
    { denyByDefault: true },
    { externalDataEgress: 'deny-except-model-transport' },
    { modelTransportIsolation: 'parent-only' },
    { filesystemOutsideAttempt: 'read-only' },
    { releaseEligible: true },
    { descendantInheritance: 'best-effort' },
  ]) {
    assert.throws(() => validateWindowsJobProfile({ ...profile, ...mutation }, WINDOWS_PLATFORM));
  }
});

test('measurement is stable, exact-profile-bound, helper-bound, and native-policy-bound', async () => {
  const profileBytes = await readFile(profileFile);
  const launcherBytes = await readFile(launcherFile);
  const helperBytes = await readFile(helperFile);
  const nativeFacts = { ok: true, killOnJobClose: true, breakawayAllowed: false };
  const left = measureWindowsJobBoundary({ profileBytes, launcherBytes, helperBytes, nativeFacts });
  const right = measureWindowsJobBoundary({ profileBytes, launcherBytes, helperBytes, nativeFacts });
  assert.match(left.measurement, /^[a-f0-9]{64}$/);
  assert.equal(left.measurement, right.measurement);
  assert.notEqual(left.measurement, measureWindowsJobBoundary({
    profileBytes: Buffer.concat([profileBytes, Buffer.from(' ')]), launcherBytes, helperBytes, nativeFacts,
  }).measurement);
  assert.notEqual(left.measurement, measureWindowsJobBoundary({
    profileBytes, launcherBytes, helperBytes: Buffer.concat([helperBytes, Buffer.from(' ')]), nativeFacts,
  }).measurement);
  assert.notEqual(left.measurement, measureWindowsJobBoundary({
    profileBytes, launcherBytes, helperBytes, nativeFacts: { ...nativeFacts, killOnJobClose: false },
  }).measurement);
});

test('attestation is exact-profile-bound but remains typed and fail-closed', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async () => {
  const profileBytes = await readFile(profileFile);
  const challenge = 'a'.repeat(64);
  const profileSha256 = sha256(profileBytes);
  const result = spawnSync(process.execPath, [launcherFile, '--attest', profileFile], {
    encoding: 'utf8',
    input: JSON.stringify({
      schemaVersion: '1.0.0',
      challenge,
      profileSha256,
      profileSemanticsSha256: 'b'.repeat(64),
      requiredCoverage: WINDOWS_JOB_REQUIRED_COVERAGE,
    }),
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const attestation = JSON.parse(result.stdout);
  assert.equal(attestation.ok, false);
  assert.equal(attestation.boundaryAvailable, true);
  assert.equal(attestation.releaseEligible, false);
  assert.equal(attestation.errorCode, 'partial-boundary-not-release-eligible');
  assert.equal(attestation.challenge, challenge);
  assert.equal(attestation.profileSha256, profileSha256);
  assert.match(attestation.measurement, /^[a-f0-9]{64}$/);
  assert.throws(() => validateConfinementAttestation(attestation, {
    challenge,
    profileSha256,
    profileSemanticsSha256: 'b'.repeat(64),
    mechanism: attestation.mechanism,
  }), /did not attest success/);
});

test('native launcher starts the target suspended, contains a child and grandchild, and preserves exit status', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 60_000,
}, () => {
  const tree = spawnSync(process.execPath, [launcherFile, '--run', profileFile, process.execPath, targetFile, 'report-tree'], {
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });
  assert.equal(tree.status, 0, tree.stderr);
  const report = JSON.parse(tree.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.targetProbeProcessInJob, true);
  assert.equal(report.descendant.descendantProbeProcessInJob, true);

  const exit = spawnSync(process.execPath, [launcherFile, '--run', profileFile, process.execPath, targetFile, 'exit', '23'], {
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });
  assert.equal(exit.status, 23, exit.stderr);
  assert.deepEqual(JSON.parse(exit.stdout), { ok: true, exitCode: 23 });
});

test('killing the launcher kills the complete associated descendant tree before delayed escape', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-job-object-kill-'));
  const markerFile = join(root, 'escaped.txt');
  const launcher = spawn(process.execPath, [
    launcherFile, '--run', profileFile, process.execPath, targetFile, 'linger-tree', markerFile, '2500',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  try {
    const ready = await readFirstJsonLine(launcher.stdout, 30_000);
    assert.equal(ready.ready, true);
    launcher.kill();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_500));
    await assert.rejects(readFile(markerFile), { code: 'ENOENT' });
  } finally {
    if (launcher.exitCode === null) launcher.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('assessment never promotes a real Job Object boundary to release eligibility', async () => {
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  const report = assessWindowsJobBoundary(profile, successfulNativeFacts(), { platform: 'win32', architecture: 'x64' });
  assert.equal(report.ok, true);
  assert.equal(report.boundaryAvailable, true);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.coversDescendants, true);
  assert.deepEqual(report.limitations, WINDOWS_JOB_LIMITATIONS);
});

test('availability requires an observed disposable-process assignment, membership check, and termination', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async () => {
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  const incomplete = assessWindowsJobBoundary(profile, { ok: true }, { platform: 'win32', architecture: 'x64' });
  assert.equal(incomplete.boundaryAvailable, false);
  assert.ok(incomplete.blockers.includes('native-job-object-assignment-not-proven'));

  const facts = probeNativeJobHost();
  assert.deepEqual({
    ok: facts.ok,
    assignmentAttempted: facts.assignmentAttempted,
    assignedProcessInJob: facts.assignedProcessInJob,
    disposableTargetTerminated: facts.disposableTargetTerminated,
    createProcessSuspended: facts.createProcessSuspended,
  }, {
    ok: true,
    assignmentAttempted: true,
    assignedProcessInJob: true,
    disposableTargetTerminated: true,
    createProcessSuspended: true,
  });
  assert.equal(assessWindowsJobBoundary(profile, facts, { platform: 'win32', architecture: 'x64' }).boundaryAvailable, true);
});

function successfulNativeFacts() {
  return {
    ok: true,
    assignmentAttempted: true,
    assignedProcessInJob: true,
    disposableTargetTerminated: true,
    createProcessSuspended: true,
    breakawayAllowed: false,
    killOnJobClose: true,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readFirstJsonLine(stream, timeoutMs) {
  return new Promise((resolveLine, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for launcher target output.')), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveLine(JSON.parse(buffered.slice(0, newline)));
    });
    stream.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
