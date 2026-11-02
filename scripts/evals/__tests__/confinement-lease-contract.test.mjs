import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  CONFINEMENT_LEASE_ENFORCEMENT_CLAIMS,
  CONFINEMENT_LEASE_REQUIRED_COVERAGE,
  assessConfinementLeaseAttestation,
  computeConfinementAttestationMeasurement,
  computeConfinementMeasurement,
  unavailableConfinementLease,
  validateConfinementLeaseAttestation,
} from '../security/confinement-lease-contract.mjs';
import { isVerifiedConfinementLeaseSummary, openConfinementLease } from '../security/confinement-lease-client.mjs';

const providerFile = resolve('scripts/evals/__tests__/fixtures/fake-confinement-lease-provider.mjs');
const challenge = 'a'.repeat(64);
const profileSha256 = 'b'.repeat(64);
const profileSemanticsSha256 = 'c'.repeat(64);
const configurationDigest = 'e'.repeat(64);
const attemptKey = 'attempt-confinement-0001';
const providerSha256 = digest(await readFile(providerFile));
const approvedProvider = {
  providerSha256,
  mechanism: 'windows-hyperv-job-wfp',
  providerKind: 'windows-guest-confinement',
  providerVersion: '1.0.0',
  signingIdentity: 'CN=Marshal Production Confinement',
};
const executionPlanDigest = computeConfinementMeasurement({
  attemptKey,
  configurationDigest,
  requiredRoles: ['codex-process', 'marshal-plugin-children', 'workspace-command-children', 'objective-oracle'],
  uiRequired: false,
});

test('long-lived lease sequences commands and emits a cleanup-bound receipt bundle', async () => {
  const client = await openFake('partial');
  assert.equal(client.inspect().assessment.releaseEligible, false);
  assert.match(client.inspect().assessment.blockers.join('\n'), /filesystem|egress|parentOnly|test-only/i);
  const first = await client.execute({ commandId: 'command-0001', role: 'codex-process', stdin: 'first' });
  const second = await client.execute({ commandId: 'command-0002', role: 'objective-oracle', stdin: 'second' });
  assert.equal(first.sequence, 2);
  assert.equal(second.sequence, 3);
  const cleaned = await client.cleanup();
  assert.equal(cleaned.cleanupReceipt.sequence, 4);
  assert.equal(cleaned.summary.status, 'cleaned');
  assert.equal(cleaned.summary.releaseEligible, false);
  assert.equal(isVerifiedConfinementLeaseSummary(cleaned.summary), true);
  assert.match(cleaned.receiptBundle.receiptBundleSha256, /^[a-f0-9]{64}$/);
  assert.match(cleaned.receiptBundle.attestationDigest, /^[a-f0-9]{64}$/);
  assert.equal(cleaned.receiptBundle.challenge, challenge);
  assert.deepEqual(cleaned.receiptBundle.commandReceiptDigests, [first.receiptSha256, second.receiptSha256]);
  await assert.rejects(() => client.execute({ commandId: 'command-0003', role: 'codex-process' }), /open lease/);
});

test('lease rejects replay or challenge substitution', async () => {
  await assert.rejects(() => openFake('challenge-mismatch'), /challenge mismatch/i);
});

test('lease rejects out-of-sequence provider frames', async () => {
  await assert.rejects(() => openFake('sequence-mismatch'), /sequence mismatch/i);
});

test('post-open frame failure aborts the provider and cannot be cleaned successfully', async () => {
  const client = await openFake('command-sequence-mismatch');
  await assert.rejects(() => client.execute({ commandId: 'command-bad-frame', role: 'codex-process' }), /sequence mismatch/i);
  assert.equal(client.inspect().state, 'aborted');
  assert.equal(client.inspect().providerKilled, true);
  await assert.rejects(() => client.cleanup(), /open lease/i);
});

test('cleanup is fail-closed when descendants or resources remain', async () => {
  const client = await openFake('cleanup-incomplete');
  await assert.rejects(() => client.cleanup(), /cleanup did not complete|active processes/i);
  client.abort();
});

test('measurement changes for exact policy mutation', async () => {
  const left = computeConfinementMeasurement({ policy: { egress: 'deny' }, generation: 1 });
  const right = computeConfinementMeasurement({ policy: { egress: 'allow' }, generation: 1 });
  assert.notEqual(left, right);
  assert.equal(left, computeConfinementMeasurement({ generation: 1, policy: { egress: 'deny' } }));
  const first = await openFake('partial', 'a');
  const second = await openFake('partial', 'b');
  assert.notEqual(first.inspect().attestation.measurement, second.inspect().attestation.measurement);
  const tampered = structuredClone(first.inspect().attestation);
  tampered.policy.providerRevision = 'mutated-after-measurement';
  assert.throws(() => validateConfinementLeaseAttestation(tampered, expected(false)), /policy measurement mismatch/i);
  await first.cleanup();
  await second.cleanup();
});

test('provider cannot self-assert release eligibility without every independent enforcement claim', async () => {
  await assert.rejects(() => openFake('false-release-claim'), /falsely claimed release eligibility/i);
});

test('self-hashed fake cannot promote itself by copying production labels without runner approval', async () => {
  await assert.rejects(() => openFake('self-labeled-production'), /not-approved-by-runner|falsely claimed/i);
});

test('call-option approval and injected transports cannot mint release authority or skip execution', async () => {
  const clientModule = await import('../security/confinement-lease-client.mjs');
  assert.equal('ConfinementLeaseClient' in clientModule, false);
  await assert.rejects(() => openFake('self-labeled-production', 'a', {
    spawn,
    approvedProviders: [approvedProvider],
  }), /runner-owned frozen authority/i);
  const client = await openFake('partial', 'a', { spawn });
  assert.equal(Object.getPrototypeOf(client), null);
  assert.deepEqual(Reflect.ownKeys(client).sort(), ['abort', 'cleanup', 'execute', 'inspect']);
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(Reflect.set(client, 'assessment', { releaseEligible: true, blockers: [] }), false);
  assert.equal(Reflect.setPrototypeOf(client, { assessment: { releaseEligible: true } }), false);
  const inspection = client.inspect();
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(Object.isFrozen(inspection.assessment), true);
  const cleaned = await client.cleanup();
  assert.equal(cleaned.summary.releaseEligible, false);
  assert.equal(cleaned.summary.commandReceiptCount, 0);
  assert.match(cleaned.summary.blockers.join('\n'), /no-command-receipts|test-transport|persisted-cryptographic/i);
  assert.equal(Object.isFrozen(cleaned.summary), true);
  assert.equal(Reflect.set(cleaned.summary, 'releaseEligible', true), false);
  assert.equal(isVerifiedConfinementLeaseSummary(cleaned.summary), true);
  assert.equal(isVerifiedConfinementLeaseSummary(structuredClone(cleaned.summary)), false);
});

test('full release assessment requires production mechanism, kernel mode, coverage, and every enforcement claim', () => {
  const attestation = {
    schemaVersion: '1.0.0',
    ok: true,
    leaseId: 'production-lease-0001',
    challenge,
    attemptKey,
    configurationDigest,
    providerSha256,
    providerKind: approvedProvider.providerKind,
    providerVersion: approvedProvider.providerVersion,
    signingIdentity: approvedProvider.signingIdentity,
    executionPlanDigest,
    profileSha256,
    profileSemanticsSha256,
    mechanism: 'windows-hyperv-job-wfp',
    enforcementMode: 'kernel',
    testOnly: false,
    coversDescendants: true,
    coverage: CONFINEMENT_LEASE_REQUIRED_COVERAGE,
    releaseEligible: true,
    enforcement: Object.fromEntries(CONFINEMENT_LEASE_ENFORCEMENT_CLAIMS.map((name) => [name, true])),
    policy: { guestBoundary: 'ephemeral', egress: 'parent-model-transport-only' },
  };
  attestation.measurement = computeConfinementAttestationMeasurement(attestation);
  assert.equal(validateConfinementLeaseAttestation(attestation, expected(true)).releaseEligible, true);
  const omittedProfiles = structuredClone(attestation);
  delete omittedProfiles.profileSha256;
  delete omittedProfiles.profileSemanticsSha256;
  omittedProfiles.measurement = computeConfinementAttestationMeasurement(omittedProfiles);
  assert.throws(() => validateConfinementLeaseAttestation(omittedProfiles, expected(true)), /profile digest is missing/i);
  const unknownMechanism = structuredClone(attestation);
  unknownMechanism.mechanism = 'unknown-kernel-confinement';
  unknownMechanism.measurement = computeConfinementAttestationMeasurement(unknownMechanism);
  assert.throws(() => validateConfinementLeaseAttestation(unknownMechanism, expected(true)), /not-approved|falsely claimed/i);
  for (const claim of [
    'filesystemOutsideAttemptReadOnly',
    'externalEgressDenyExceptModelTransport',
    'parentOnlyModelTransport',
  ]) {
    const missing = structuredClone(attestation);
    missing.enforcement[claim] = false;
    const assessment = assessConfinementLeaseAttestation(missing, expected(false));
    assert.equal(assessment.releaseEligible, false, claim);
    assert.match(assessment.blockers.join('\n'), new RegExp(claim), claim);
  }
});

test('default integration summary is explicitly unavailable and never release eligible', () => {
  const summary = unavailableConfinementLease();
  assert.equal(summary.providerConfigured, false);
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.releaseEligible, false);
  assert.equal(summary.attestationMeasurement, null);
});

async function openFake(scenario, variant = 'a', options = {}) {
  return openConfinementLease({
    providerCommand: process.execPath,
    providerArgs: [providerFile, scenario, variant],
    providerFile,
    providerSha256,
    env: {},
  }, {
    challenge,
    attemptKey,
    configurationDigest,
    profileSha256,
    profileSemanticsSha256,
    requiredCoverage: CONFINEMENT_LEASE_REQUIRED_COVERAGE,
    requireReleaseEligible: false,
  }, options);
}

function expected(requireReleaseEligible) {
  return { challenge, attemptKey, configurationDigest, providerSha256, executionPlanDigest, profileSha256, profileSemanticsSha256,
    approvedProvider, requiredCoverage: CONFINEMENT_LEASE_REQUIRED_COVERAGE, requireReleaseEligible };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
