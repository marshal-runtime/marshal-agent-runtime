#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  CONFINEMENT_LEASE_FRAME_TYPES,
  CONFINEMENT_LEASE_SCHEMA_VERSION,
  computeConfinementAttestationMeasurement,
  computeConfinementMeasurement,
  createConfinementLeaseFrame,
} from '../../security/confinement-lease-contract.mjs';

const scenario = process.argv[2] ?? 'partial';
const variant = process.argv[3] ?? 'a';
const leaseId = 'fixture-lease-0001';
let expectedSequence = 1;
let opened = false;
let leaseMeasurement;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (frame.sequence !== expectedSequence) throw new Error(`Expected sequence ${expectedSequence}.`);
  expectedSequence += 1;
  if (frame.type === CONFINEMENT_LEASE_FRAME_TYPES.openRequest) {
    const selfLabeledProduction = scenario === 'self-labeled-production';
    const full = scenario === 'full-test-only' || selfLabeledProduction;
    const enforcement = Object.fromEntries([
      'policyBeforeTargetStart',
      'mandatoryDescendantInheritance',
      'filesystemOutsideAttemptReadOnly',
      'externalEgressDenyExceptModelTransport',
      'parentOnlyModelTransport',
      'killCompleteProcessTree',
      'measuredKernelPolicy',
    ].map((name) => [name, full || ['policyBeforeTargetStart', 'mandatoryDescendantInheritance', 'killCompleteProcessTree'].includes(name)]));
    const attestation = {
      schemaVersion: CONFINEMENT_LEASE_SCHEMA_VERSION,
      ok: true,
      leaseId,
      challenge: scenario === 'challenge-mismatch' ? '0'.repeat(64) : frame.payload.challenge,
      attemptKey: frame.payload.attemptKey,
      configurationDigest: frame.payload.configurationDigest,
      providerSha256: frame.payload.providerSha256,
      profileSha256: frame.payload.profileSha256,
      profileSemanticsSha256: frame.payload.profileSemanticsSha256,
      mechanism: selfLabeledProduction ? 'windows-hyperv-job-wfp' : 'fixture-confinement-lease-provider',
      providerKind: selfLabeledProduction ? 'windows-guest-confinement' : 'fixture',
      providerVersion: '1.0.0',
      signingIdentity: selfLabeledProduction ? 'CN=Marshal Production Confinement' : 'unsigned-fixture',
      executionPlanDigest: frame.payload.executionPlanDigest,
      enforcementMode: 'kernel',
      testOnly: !selfLabeledProduction,
      coversDescendants: true,
      coverage: frame.payload.requiredCoverage,
      enforcement,
      policy: { providerRevision: variant, scenario },
    };
    attestation.measurement = computeConfinementAttestationMeasurement(attestation);
    attestation.releaseEligible = scenario === 'false-release-claim' || selfLabeledProduction;
    leaseMeasurement = attestation.measurement;
    const sequence = scenario === 'sequence-mismatch' ? frame.sequence + 1 : frame.sequence;
    process.stdout.write(`${JSON.stringify(createConfinementLeaseFrame(
      CONFINEMENT_LEASE_FRAME_TYPES.openResponse,
      frame.requestId,
      sequence,
      attestation,
    ))}\n`);
    opened = true;
    continue;
  }
  if (!opened || frame.payload.leaseId !== leaseId) throw new Error('Lease is not open.');
  if (frame.type === CONFINEMENT_LEASE_FRAME_TYPES.commandRequest) {
    const receipt = {
      schemaVersion: CONFINEMENT_LEASE_SCHEMA_VERSION,
      ok: true,
      leaseId,
      commandId: frame.payload.commandId,
      sequence: frame.sequence,
      role: frame.payload.role,
      commandSha256: computeConfinementMeasurement(frame.payload),
      exitCode: 0,
      stdoutSha256: digest(String(frame.payload.stdin ?? '')),
      stderrSha256: digest(''),
      enforcementMeasurement: leaseMeasurement,
    };
    receipt.receiptSha256 = computeConfinementMeasurement(receipt);
    process.stdout.write(`${JSON.stringify(createConfinementLeaseFrame(
      CONFINEMENT_LEASE_FRAME_TYPES.commandResponse,
      frame.requestId,
      scenario === 'command-sequence-mismatch' ? frame.sequence + 1 : frame.sequence,
      receipt,
    ))}\n`);
    continue;
  }
  if (frame.type === CONFINEMENT_LEASE_FRAME_TYPES.cleanupRequest) {
    const incomplete = scenario === 'cleanup-incomplete';
    const receipt = {
      schemaVersion: CONFINEMENT_LEASE_SCHEMA_VERSION,
      ok: true,
      leaseId,
      sequence: frame.sequence,
      cleanupComplete: !incomplete,
      descendantsTerminated: !incomplete,
      activeProcessCount: incomplete ? 1 : 0,
      policyReleased: !incomplete,
      resourcesReleased: !incomplete,
      enforcementMeasurement: leaseMeasurement,
      cleanupMeasurement: computeConfinementMeasurement({ variant, cleanup: !incomplete }),
    };
    receipt.receiptSha256 = computeConfinementMeasurement(receipt);
    process.stdout.write(`${JSON.stringify(createConfinementLeaseFrame(
      CONFINEMENT_LEASE_FRAME_TYPES.cleanupResponse,
      frame.requestId,
      frame.sequence,
      receipt,
    ))}\n`);
    break;
  }
  throw new Error(`Unexpected frame type ${frame.type}.`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
