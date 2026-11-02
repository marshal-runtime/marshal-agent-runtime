import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  evaluateWindowsConfinementFacts,
  readNativeWindowsFacts,
  runWindowsConfinementCapabilityProbe,
  WINDOWS_CONFINEMENT_CONTRACT_INVARIANTS,
} from '../security/windows-confinement-capability-probe.mjs';

const probeFile = resolve('scripts/evals/security/windows-confinement-capability-probe.mjs');

test('stock Windows primitives fail closed even when every discoverable API is present', () => {
  const report = evaluateWindowsConfinementFacts(completeFacts(), {
    platform: 'win32',
    architecture: 'x64',
  });

  assert.equal(report.probeOnly, true);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.primitiveAssessment.jobObject.apiSurfaceAvailable, true);
  assert.equal(report.primitiveAssessment.processSandbox.apiSurfaceAvailable, true);
  assert.equal(report.primitiveAssessment.processSandbox.canGiveOnlyParentModelTransport, false);
  assert.deepEqual(report.contractInvariants, WINDOWS_CONFINEMENT_CONTRACT_INVARIANTS);
  assert.match(report.blockers.join('\n'), /parent-only-model-transport/);
  assert.match(report.blockers.join('\n'), /kernel-policy-measurement/);
  assert.match(report.evidenceSha256, /^[a-f0-9]{64}$/);
});

test('missing native APIs and non-administrator authority are reported independently', () => {
  const facts = completeFacts();
  facts.token.isAdministrator = false;
  facts.jobObject.terminate = false;
  facts.processSandbox.createProcess = false;
  facts.services.windowsFirewall = 'Stopped';

  const report = evaluateWindowsConfinementFacts(facts, { platform: 'win32', architecture: 'x64' });

  assert.equal(report.releaseEligible, false);
  assert.equal(report.primitiveAssessment.jobObject.apiSurfaceAvailable, false);
  assert.equal(report.primitiveAssessment.processSandbox.apiSurfaceAvailable, false);
  assert.equal(report.primitiveAssessment.stockWindowsFiltering.servicesRunning, false);
  assert.ok(report.blockers.includes('current-token-cannot-install-or-configure-a-privileged-confinement-provider'));
  assert.ok(report.blockers.includes('windows-job-object-api-surface-incomplete'));
  assert.ok(report.blockers.includes('windows-process-sandbox-api-unavailable'));
  assert.ok(report.blockers.includes('windows-kernel-network-filtering-services-unavailable'));
});

test('non-Windows hosts never invoke the Windows fact reader', () => {
  let invoked = false;
  const report = runWindowsConfinementCapabilityProbe({
    platform: 'linux',
    architecture: 'x64',
    readFacts() {
      invoked = true;
      throw new Error('must not run');
    },
  });

  assert.equal(invoked, false);
  assert.equal(report.releaseEligible, false);
  assert.ok(report.blockers.includes('host-platform-is-not-windows'));
  assert.ok(report.blockers.includes('windows-native-capability-probe-failed'));
});

test('fact-reader failures become explicit unavailable evidence', () => {
  const report = runWindowsConfinementCapabilityProbe({
    platform: 'win32',
    architecture: 'x64',
    readFacts() {
      throw new Error('native probe unavailable');
    },
  });

  assert.equal(report.releaseEligible, false);
  assert.equal(report.hostFacts.ok, false);
  assert.equal(report.hostFacts.error, 'native probe unavailable');
  assert.ok(report.blockers.includes('windows-native-capability-probe-failed'));
});

test('evidence digest is stable and changes when observed host facts change', () => {
  const left = evaluateWindowsConfinementFacts(completeFacts(), { platform: 'win32', architecture: 'x64' });
  const right = evaluateWindowsConfinementFacts(completeFacts(), { platform: 'win32', architecture: 'x64' });
  const changedFacts = completeFacts();
  changedFacts.os.buildNumber = '99999';
  const changed = evaluateWindowsConfinementFacts(changedFacts, { platform: 'win32', architecture: 'x64' });

  assert.equal(left.evidenceSha256, right.evidenceSha256);
  assert.notEqual(left.evidenceSha256, changed.evidenceSha256);
});

test('probe-only executable refuses launcher attestation and run modes', () => {
  for (const mode of ['--attest', '--run']) {
    const result = spawnSync(process.execPath, [probeFile, mode], { encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.probeOnly, true);
    assert.match(diagnostic.error, /not a confinement launcher/i);
  }
});

test('PowerShell transport is bounded and rejects invalid or failed output', () => {
  assert.throws(() => readNativeWindowsFacts({
    spawnSync() {
      return { status: 0, stdout: 'not-json', stderr: '' };
    },
  }), /invalid JSON/);

  assert.throws(() => readNativeWindowsFacts({
    spawnSync() {
      return { status: 7, stdout: '', stderr: 'native failure' };
    },
  }), /exited 7.*native failure/);
});

test('native Windows probe returns measured host facts without claiming release eligibility', {
  skip: process.platform !== 'win32',
}, () => {
  const report = runWindowsConfinementCapabilityProbe();
  assert.equal(report.hostFacts.ok, true);
  assert.equal(report.releaseEligible, false);
  assert.equal(typeof report.hostFacts.os.buildNumber, 'string');
  assert.match(report.evidenceSha256, /^[a-f0-9]{64}$/);
});

function completeFacts() {
  return {
    ok: true,
    os: {
      caption: 'Microsoft Windows 11 Enterprise',
      version: '10.0.26200',
      buildNumber: '26200',
      architecture: '64-bit',
    },
    token: {
      isAdministrator: true,
      isAppContainer: false,
      currentProcessIsInJob: false,
    },
    services: {
      baseFilteringEngine: 'Running',
      windowsFirewall: 'Running',
    },
    jobObject: {
      create: true,
      assign: true,
      configure: true,
      query: true,
      terminate: true,
    },
    processSandbox: {
      dllPresent: true,
      fileVersion: '10.0.26200.1',
      createProcess: true,
      createProcessAsUser: true,
      experimental: true,
    },
  };
}
