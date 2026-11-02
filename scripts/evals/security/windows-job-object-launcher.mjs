#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WINDOWS_JOB_LAUNCHER_SCHEMA_VERSION = '1.0.0';
export const WINDOWS_JOB_MECHANISM = 'windows-job-object-kill-on-close';
export const WINDOWS_JOB_REQUIRED_COVERAGE = Object.freeze([
  'codex-process',
  'marshal-plugin-children',
  'workspace-command-children',
  'objective-oracle',
]);
export const WINDOWS_JOB_LIMITATIONS = Object.freeze([
  'network-egress-is-not-confined',
  'filesystem-access-is-not-confined',
  'model-transport-is-not-parent-only',
  'no-loaded-network-or-filesystem-kernel-policy-measurement',
]);

const launcherFile = fileURLToPath(import.meta.url);
const helperFile = resolve(dirname(launcherFile), 'windows-job-object-host.ps1');
// The launcher is the hash-pinned protocol entry point. It also fail-closes if
// its native helper differs from these reviewed bytes.
const EXPECTED_HELPER_SHA256 = '00b248ff3d42a83bd216145cd2446005bb9563fa0a1fb7407566ecbe1b02d769';
const NATIVE_POLICY = Object.freeze({
  assignBeforeFirstInstruction: true,
  breakawayAllowed: false,
  killOnJobClose: true,
  ownerDeathMonitored: true,
  targetCreationFlags: ['CREATE_SUSPENDED', 'CREATE_UNICODE_ENVIRONMENT'],
});

export function validateWindowsJobProfile(profile, expectedPlatform = `${process.platform}-${process.arch}`) {
  assert(profile?.schemaVersion === WINDOWS_JOB_LAUNCHER_SCHEMA_VERSION, 'Job profile schemaVersion must be 1.0.0.');
  assert(profile.profileId === 'windows-job-object-descendants', 'Unexpected Job Object profileId.');
  assert(Array.isArray(profile.platforms) && profile.platforms.includes(expectedPlatform), `Job profile does not cover ${expectedPlatform}.`);
  assert(profile.mechanism === WINDOWS_JOB_MECHANISM, `Job profile mechanism must be ${WINDOWS_JOB_MECHANISM}.`);
  assert(profile.testOnly === false, 'The real Job Object boundary must set testOnly=false.');
  assert(profile.enforcementMode === 'kernel', 'Job Object process-tree enforcement is kernel-backed.');
  assert(profile.denyByDefault === false, 'The Job Object profile must not claim deny-by-default data isolation.');
  assert(profile.descendantInheritance === 'mandatory', 'Job Object descendants must inherit membership.');
  assert(profile.externalDataEgress === 'unrestricted', 'The Job Object profile must disclose unrestricted egress.');
  assert(profile.modelTransportIsolation === 'shared-with-descendants', 'The Job Object profile must disclose shared model transport authority.');
  assert(profile.filesystemOutsideAttempt === 'unrestricted', 'The Job Object profile must disclose unrestricted filesystem access.');
  assert(profile.releaseEligible === false, 'The Job Object-only profile must remain release-ineligible.');
  assert(profile.jobLimits?.killOnJobClose === true, 'killOnJobClose must be enabled.');
  assert(profile.jobLimits?.breakawayAllowed === false, 'Process breakaway must remain disabled.');
  assert(profile.jobLimits?.ownerDeathMonitored === true, 'Launcher-owner death must be monitored.');
  assert(profile.jobLimits?.targetStart === 'suspended-before-assignment', 'Target assignment must precede its first instruction.');
  assert(equalSets(profile.coverage, WINDOWS_JOB_REQUIRED_COVERAGE), 'Job Object coverage must name every runner process class.');
  assert(equalSets(profile.limitations, WINDOWS_JOB_LIMITATIONS), 'Job Object limitations must be complete and exact.');
  return profile;
}

export function measureWindowsJobBoundary({ profileBytes, launcherBytes, helperBytes, nativeFacts }) {
  const evidence = {
    schemaVersion: WINDOWS_JOB_LAUNCHER_SCHEMA_VERSION,
    mechanism: WINDOWS_JOB_MECHANISM,
    profileSha256: sha256(profileBytes),
    launcherSha256: sha256(launcherBytes),
    helperSha256: sha256(helperBytes),
    nativePolicy: NATIVE_POLICY,
    nativeFacts,
  };
  return {
    evidence,
    measurement: sha256(canonicalJson(evidence)),
  };
}

export function assessWindowsJobBoundary(profile, nativeFacts, options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const blockers = [...WINDOWS_JOB_LIMITATIONS];
  let profileValid = false;
  let profileError;
  try {
    validateWindowsJobProfile(profile, `${platform}-${architecture}`);
    profileValid = true;
  } catch (error) {
    profileError = error instanceof Error ? error.message : String(error);
    blockers.push('profile-does-not-match-the-reviewed-job-object-boundary');
  }
  if (platform !== 'win32') blockers.push('host-platform-is-not-windows');
  if (architecture !== 'x64') blockers.push('host-architecture-is-not-x64');
  const nativeAssignmentProven = nativeFacts?.ok === true
    && nativeFacts.assignmentAttempted === true
    && nativeFacts.assignedProcessInJob === true
    && nativeFacts.disposableTargetTerminated === true
    && nativeFacts.createProcessSuspended === true
    && nativeFacts.breakawayAllowed === false
    && nativeFacts.killOnJobClose === true;
  if (!nativeAssignmentProven) blockers.push('native-job-object-assignment-not-proven');
  return {
    schemaVersion: WINDOWS_JOB_LAUNCHER_SCHEMA_VERSION,
    ok: nativeAssignmentProven && profileValid,
    boundaryAvailable: nativeAssignmentProven && profileValid,
    releaseEligible: false,
    mechanism: WINDOWS_JOB_MECHANISM,
    enforcementMode: 'kernel',
    coversDescendants: nativeAssignmentProven && profileValid,
    coverage: WINDOWS_JOB_REQUIRED_COVERAGE,
    profileValid,
    profileError,
    nativePolicy: NATIVE_POLICY,
    nativeFacts,
    limitations: WINDOWS_JOB_LIMITATIONS,
    blockers: [...new Set(blockers)].sort(),
  };
}

export function probeNativeJobHost(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, error: 'The native Job Object helper only runs on Windows.' };
  }
  const result = (options.spawnSync ?? spawnSync)(
    options.powerShellCommand ?? 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperFile, '-Mode', 'probe', '-OwnerPid', String(process.pid)],
    { encoding: 'utf8', maxBuffer: 512 * 1024, timeout: options.timeoutMs ?? 20_000, windowsHide: true },
  );
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: `Native Job Object probe exited ${String(result.status)}: ${String(result.stderr ?? '').trim()}` };
  try {
    return JSON.parse(String(result.stdout ?? '').trim());
  } catch (error) {
    return { ok: false, error: `Native Job Object probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function loadInputs(profilePath) {
  assert(isAbsolute(profilePath ?? ''), 'Profile path must be absolute.');
  const profileBytes = readFileSync(profilePath);
  const launcherBytes = readFileSync(launcherFile);
  const helperBytes = readFileSync(helperFile);
  assert(sha256(helperBytes) === EXPECTED_HELPER_SHA256, 'Native Job Object helper digest mismatch.');
  let profile;
  try {
    profile = JSON.parse(profileBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Job profile is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { profile, profileBytes, launcherBytes, helperBytes };
}

async function attest(profilePath) {
  const input = loadInputs(profilePath);
  const request = JSON.parse(await readStdin());
  assert(typeof request.challenge === 'string' && /^[a-f0-9]{64}$/.test(request.challenge), 'A fresh 256-bit hexadecimal challenge is required.');
  assert(typeof request.profileSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.profileSha256), 'The requested profile digest is invalid.');
  assert(request.profileSha256 === sha256(input.profileBytes), 'Requested profile digest does not match the exact profile bytes.');
  assert(typeof request.profileSemanticsSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.profileSemanticsSha256), 'The requested profile-semantics digest is invalid.');
  const nativeFacts = probeNativeJobHost();
  const assessment = assessWindowsJobBoundary(input.profile, nativeFacts);
  const measured = measureWindowsJobBoundary({ ...input, nativeFacts });
  return {
    ...assessment,
    ok: false,
    errorCode: assessment.boundaryAvailable ? 'partial-boundary-not-release-eligible' : 'job-object-boundary-unavailable',
    challenge: request.challenge,
    profileSha256: request.profileSha256,
    profileSemanticsSha256: request.profileSemanticsSha256,
    testOnly: false,
    measurementKind: 'launcher-profile-helper-and-native-job-policy',
    measurement: measured.measurement,
  };
}

function probe(profilePath) {
  const input = loadInputs(profilePath);
  const nativeFacts = probeNativeJobHost();
  const assessment = assessWindowsJobBoundary(input.profile, nativeFacts);
  const measured = measureWindowsJobBoundary({ ...input, nativeFacts });
  return {
    ...assessment,
    profileSha256: sha256(input.profileBytes),
    launcherSha256: sha256(input.launcherBytes),
    helperSha256: sha256(input.helperBytes),
    measurementKind: 'launcher-profile-helper-and-native-job-policy',
    measurement: measured.measurement,
  };
}

async function run(profilePath, command, args) {
  const input = loadInputs(profilePath);
  validateWindowsJobProfile(input.profile);
  const nativeFacts = probeNativeJobHost();
  const assessment = assessWindowsJobBoundary(input.profile, nativeFacts);
  assert(assessment.boundaryAvailable === true, `Native Job Object boundary unavailable: ${assessment.blockers.join(', ')}`);
  assert(isAbsolute(command ?? ''), 'Confined command path must be absolute.');

  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helperFile, '-Mode', 'run', '-OwnerPid', String(process.pid),
  ], {
    env: {
      ...process.env,
      MARSHAL_JOB_LAUNCH_REQUEST: JSON.stringify({ command, arguments: args }),
    },
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 125));
  });
  return exitCode;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const profilePath = args[1];
  if (!['--probe', '--attest', '--run'].includes(mode) || !profilePath) {
    throw new UsageError('Usage: windows-job-object-launcher.mjs --probe|--attest <absolute-profile> OR --run <absolute-profile> <absolute-command> [...args]');
  }
  if (mode === '--probe') {
    process.stdout.write(`${JSON.stringify(probe(profilePath))}\n`);
    return;
  }
  if (mode === '--attest') {
    process.stdout.write(`${JSON.stringify(await attest(profilePath))}\n`);
    return;
  }
  if (!args[2]) throw new UsageError('--run requires an absolute command.');
  process.exitCode = await run(profilePath, args[2], args.slice(3));
}

function equalSets(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === right.length && right.every((value) => values.has(value));
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class UsageError extends Error {}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: WINDOWS_JOB_LAUNCHER_SCHEMA_VERSION,
      ok: false,
      releaseEligible: false,
      errorCode: error instanceof UsageError ? 'usage' : 'job-object-launcher-error',
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = error instanceof UsageError ? 64 : 2;
  });
}
