import { createHash } from 'node:crypto';

export const CONFINEMENT_LEASE_SCHEMA_VERSION = '1.0.0';
export const CONFINEMENT_LEASE_FRAME_TYPES = Object.freeze({
  openRequest: 'lease.open',
  openResponse: 'lease.opened',
  commandRequest: 'lease.command',
  commandResponse: 'lease.command.completed',
  cleanupRequest: 'lease.cleanup',
  cleanupResponse: 'lease.cleaned',
});
export const CONFINEMENT_LEASE_REQUIRED_COVERAGE = Object.freeze([
  'codex-process',
  'marshal-plugin-children',
  'workspace-command-children',
  'objective-oracle',
]);
export const CONFINEMENT_LEASE_ENFORCEMENT_CLAIMS = Object.freeze([
  'policyBeforeTargetStart',
  'mandatoryDescendantInheritance',
  'filesystemOutsideAttemptReadOnly',
  'externalEgressDenyExceptModelTransport',
  'parentOnlyModelTransport',
  'killCompleteProcessTree',
  'measuredKernelPolicy',
]);

export function computeConfinementMeasurement(value) {
  return sha256(canonicalJson(value));
}

export function computeConfinementAttestationMeasurement(attestation) {
  return computeConfinementMeasurement({
    schemaVersion: attestation?.schemaVersion,
    leaseId: attestation?.leaseId,
    challenge: attestation?.challenge,
    attemptKey: attestation?.attemptKey,
    configurationDigest: attestation?.configurationDigest,
    providerSha256: attestation?.providerSha256,
    providerKind: attestation?.providerKind,
    providerVersion: attestation?.providerVersion,
    signingIdentity: attestation?.signingIdentity,
    executionPlanDigest: attestation?.executionPlanDigest,
    profileSha256: attestation?.profileSha256,
    profileSemanticsSha256: attestation?.profileSemanticsSha256,
    mechanism: attestation?.mechanism,
    enforcementMode: attestation?.enforcementMode,
    testOnly: attestation?.testOnly,
    coversDescendants: attestation?.coversDescendants,
    coverage: attestation?.coverage,
    enforcement: attestation?.enforcement,
    policy: attestation?.policy,
  });
}

export function assessConfinementLeaseAttestation(attestation, expected = {}) {
  const blockers = [];
  if (attestation?.schemaVersion !== CONFINEMENT_LEASE_SCHEMA_VERSION) blockers.push('schema-version-mismatch');
  if (attestation?.ok !== true) blockers.push('provider-did-not-attest-success');
  if (!validLeaseId(attestation?.leaseId)) blockers.push('invalid-lease-id');
  if (!validDigest(attestation?.profileSha256)) blockers.push('missing-profile-digest');
  if (!validDigest(attestation?.profileSemanticsSha256)) blockers.push('missing-profile-semantics-digest');
  if (!validDigest(attestation?.providerSha256)) blockers.push('missing-provider-digest');
  if (!validDigest(attestation?.executionPlanDigest)) blockers.push('missing-execution-plan-digest');
  if (!validDigest(attestation?.measurement)) blockers.push('missing-policy-measurement');
  if (!attestation?.policy || typeof attestation.policy !== 'object' || Array.isArray(attestation.policy)) blockers.push('missing-policy-description');
  if (validDigest(attestation?.measurement)
    && attestation.measurement !== computeConfinementAttestationMeasurement(attestation)) blockers.push('policy-measurement-mismatch');
  if (attestation?.enforcementMode !== 'kernel') blockers.push('enforcement-is-not-kernel-backed');
  if (attestation?.testOnly !== false) blockers.push('provider-is-test-only');
  if (attestation?.coversDescendants !== true) blockers.push('descendant-coverage-is-incomplete');
  if (typeof attestation?.mechanism !== 'string'
    || attestation.mechanism.length === 0
    || /(?:fake|fixture|test|pass.?through|cooperative|simulat)/i.test(attestation.mechanism)) {
    blockers.push('mechanism-is-not-release-eligible');
  }
  const coverage = new Set(attestation?.coverage ?? []);
  if (!CONFINEMENT_LEASE_REQUIRED_COVERAGE.every((value) => coverage.has(value))) blockers.push('required-coverage-is-incomplete');
  for (const claim of CONFINEMENT_LEASE_ENFORCEMENT_CLAIMS) {
    if (attestation?.enforcement?.[claim] !== true) blockers.push(`missing-enforcement-${claim}`);
  }
  if (expected.challenge !== undefined && attestation?.challenge !== expected.challenge) blockers.push('challenge-mismatch');
  if (expected.attemptKey !== undefined && attestation?.attemptKey !== expected.attemptKey) blockers.push('attempt-key-mismatch');
  if (expected.configurationDigest !== undefined
    && attestation?.configurationDigest !== expected.configurationDigest) blockers.push('configuration-digest-mismatch');
  if (expected.providerSha256 !== undefined && attestation?.providerSha256 !== expected.providerSha256) blockers.push('provider-identity-mismatch');
  if (expected.executionPlanDigest !== undefined
    && attestation?.executionPlanDigest !== expected.executionPlanDigest) blockers.push('execution-plan-digest-mismatch');
  if (expected.executionPlanDigest === undefined) blockers.push('expected-execution-plan-digest-unavailable');
  const approvedProvider = expected.approvedProvider;
  if (!approvedProvider) {
    blockers.push('provider-not-approved-by-runner');
  } else {
    if (approvedProvider.providerSha256 !== expected.providerSha256) blockers.push('approved-provider-digest-mismatch');
    if (attestation?.mechanism !== approvedProvider.mechanism) blockers.push('provider-mechanism-not-approved');
    if (attestation?.providerKind !== approvedProvider.providerKind) blockers.push('provider-kind-not-approved');
    if (attestation?.providerVersion !== approvedProvider.providerVersion) blockers.push('provider-version-not-approved');
    if (attestation?.signingIdentity !== approvedProvider.signingIdentity) blockers.push('provider-signing-identity-not-approved');
  }
  if (expected.profileSha256 === undefined) blockers.push('expected-profile-digest-unavailable');
  if (expected.profileSha256 !== undefined && attestation?.profileSha256 !== expected.profileSha256) blockers.push('profile-digest-mismatch');
  if (expected.profileSemanticsSha256 === undefined) blockers.push('expected-profile-semantics-digest-unavailable');
  if (expected.profileSemanticsSha256 !== undefined
    && attestation?.profileSemanticsSha256 !== expected.profileSemanticsSha256) blockers.push('profile-semantics-digest-mismatch');
  if (expected.requiredCoverage !== undefined) {
    const expectedCoverage = new Set(expected.requiredCoverage);
    if (![...expectedCoverage].every((value) => coverage.has(value))) blockers.push('requested-coverage-is-incomplete');
  }
  const evidenceReleaseEligible = blockers.length === 0;
  if (attestation?.releaseEligible === true && !evidenceReleaseEligible) blockers.push('provider-falsely-claimed-release-eligibility');
  return {
    releaseEligible: attestation?.releaseEligible === true && blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}

export function validateConfinementLeaseAttestation(attestation, expected = {}) {
  const assessment = assessConfinementLeaseAttestation(attestation, expected);
  assert(!assessment.blockers.includes('schema-version-mismatch'), 'Confinement lease attestation schemaVersion must be 1.0.0.');
  assert(!assessment.blockers.includes('provider-did-not-attest-success'), 'Confinement lease provider did not attest success.');
  assert(!assessment.blockers.includes('invalid-lease-id'), 'Confinement lease id is missing or invalid.');
  assert(!assessment.blockers.includes('missing-profile-digest'), 'Confinement lease profile digest is missing or invalid.');
  assert(!assessment.blockers.includes('missing-profile-semantics-digest'), 'Confinement lease profile-semantics digest is missing or invalid.');
  assert(!assessment.blockers.includes('missing-provider-digest'), 'Confinement lease provider digest is missing or invalid.');
  assert(!assessment.blockers.includes('missing-execution-plan-digest'), 'Confinement lease execution-plan digest is missing or invalid.');
  assert(!assessment.blockers.includes('missing-policy-measurement'), 'Confinement lease policy measurement is missing or invalid.');
  assert(!assessment.blockers.includes('missing-policy-description'), 'Confinement lease policy description is missing or invalid.');
  assert(!assessment.blockers.includes('policy-measurement-mismatch'), 'Confinement lease policy measurement mismatch.');
  assert(!assessment.blockers.includes('challenge-mismatch'), 'Confinement lease challenge mismatch or replay.');
  assert(!assessment.blockers.includes('attempt-key-mismatch'), 'Confinement lease attempt binding mismatch.');
  assert(!assessment.blockers.includes('configuration-digest-mismatch'), 'Confinement lease configuration binding mismatch.');
  assert(!assessment.blockers.includes('provider-identity-mismatch'), 'Confinement lease provider identity mismatch.');
  assert(!assessment.blockers.includes('execution-plan-digest-mismatch'), 'Confinement lease execution-plan binding mismatch.');
  assert(!assessment.blockers.includes('profile-digest-mismatch'), 'Confinement lease profile digest mismatch.');
  assert(!assessment.blockers.includes('profile-semantics-digest-mismatch'), 'Confinement lease profile-semantics digest mismatch.');
  assert(!assessment.blockers.includes('requested-coverage-is-incomplete'), 'Confinement lease does not cover every requested process class.');
  assert(!assessment.blockers.includes('provider-falsely-claimed-release-eligibility'),
    `Confinement lease falsely claimed release eligibility: ${assessment.blockers.join(', ')}.`);
  if (expected.requireReleaseEligible === true) {
    assert(assessment.releaseEligible, `Confinement lease is not release-eligible: ${assessment.blockers.join(', ')}.`);
  }
  return { attestation, ...assessment };
}

export function validateConfinementLeaseFrame(frame, expected) {
  assert(frame?.schemaVersion === CONFINEMENT_LEASE_SCHEMA_VERSION, 'Confinement lease frame schemaVersion must be 1.0.0.');
  assert(frame.type === expected.type, `Expected confinement lease frame ${expected.type}, received ${String(frame.type)}.`);
  assert(frame.requestId === expected.requestId, 'Confinement lease frame requestId mismatch.');
  assert(frame.sequence === expected.sequence, 'Confinement lease frame sequence mismatch.');
  assert(frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload), 'Confinement lease frame payload must be an object.');
  return frame.payload;
}

export function createConfinementLeaseFrame(type, requestId, sequence, payload) {
  assert(Object.values(CONFINEMENT_LEASE_FRAME_TYPES).includes(type), `Unsupported confinement lease frame type: ${String(type)}.`);
  assert(typeof requestId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(requestId), 'Confinement lease requestId is invalid.');
  assert(Number.isInteger(sequence) && sequence >= 1, 'Confinement lease sequence must be a positive integer.');
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'Confinement lease payload must be an object.');
  return { schemaVersion: CONFINEMENT_LEASE_SCHEMA_VERSION, type, requestId, sequence, payload };
}

export function validateConfinementCommandReceipt(receipt, expected) {
  assert(receipt?.schemaVersion === CONFINEMENT_LEASE_SCHEMA_VERSION, 'Confinement command receipt schemaVersion must be 1.0.0.');
  assert(receipt.ok === true, 'Confinement command did not complete successfully.');
  assert(receipt.leaseId === expected.leaseId, 'Confinement command receipt leaseId mismatch.');
  assert(receipt.commandId === expected.commandId, 'Confinement command receipt commandId mismatch.');
  assert(receipt.sequence === expected.sequence, 'Confinement command receipt sequence mismatch.');
  assert(receipt.role === expected.role, 'Confinement command receipt role mismatch.');
  assert(receipt.commandSha256 === expected.commandSha256, 'Confinement command receipt request digest mismatch.');
  assert(Number.isInteger(receipt.exitCode), 'Confinement command receipt exitCode is missing.');
  assert(validDigest(receipt.stdoutSha256) && validDigest(receipt.stderrSha256), 'Confinement command output digests are invalid.');
  assert(receipt.enforcementMeasurement === expected.enforcementMeasurement, 'Confinement command enforcement measurement mismatch.');
  const digest = computeConfinementMeasurement(withoutDigest(receipt, 'receiptSha256'));
  assert(receipt.receiptSha256 === digest, 'Confinement command receipt digest mismatch.');
  return receipt;
}

export function validateConfinementCleanupReceipt(receipt, expected) {
  assert(receipt?.schemaVersion === CONFINEMENT_LEASE_SCHEMA_VERSION, 'Confinement cleanup receipt schemaVersion must be 1.0.0.');
  assert(receipt.ok === true && receipt.cleanupComplete === true, 'Confinement cleanup did not complete successfully.');
  assert(receipt.leaseId === expected.leaseId, 'Confinement cleanup receipt leaseId mismatch.');
  assert(receipt.sequence === expected.sequence, 'Confinement cleanup receipt sequence mismatch.');
  assert(receipt.descendantsTerminated === true, 'Confinement cleanup did not terminate descendants.');
  assert(receipt.activeProcessCount === 0, 'Confinement cleanup left active processes.');
  assert(receipt.policyReleased === true, 'Confinement cleanup did not release policy state.');
  assert(receipt.resourcesReleased === true, 'Confinement cleanup did not release attempt resources.');
  assert(receipt.enforcementMeasurement === expected.enforcementMeasurement, 'Confinement cleanup enforcement measurement mismatch.');
  assert(validDigest(receipt.cleanupMeasurement), 'Confinement cleanup measurement is invalid.');
  const digest = computeConfinementMeasurement(withoutDigest(receipt, 'receiptSha256'));
  assert(receipt.receiptSha256 === digest, 'Confinement cleanup receipt digest mismatch.');
  return receipt;
}

export function createConfinementReceiptBundle({ attestation, commandReceipts, cleanupReceipt }) {
  assert(validLeaseId(attestation?.leaseId), 'Receipt bundle requires a valid lease attestation.');
  assert(cleanupReceipt?.leaseId === attestation.leaseId, 'Receipt bundle cleanup leaseId mismatch.');
  assert(commandReceipts.every((receipt) => receipt.leaseId === attestation.leaseId), 'Receipt bundle command leaseId mismatch.');
  const bundle = {
    schemaVersion: CONFINEMENT_LEASE_SCHEMA_VERSION,
    leaseId: attestation.leaseId,
    challenge: attestation.challenge,
    attemptKey: attestation.attemptKey,
    configurationDigest: attestation.configurationDigest,
    providerSha256: attestation.providerSha256,
    providerKind: attestation.providerKind,
    providerVersion: attestation.providerVersion,
    signingIdentity: attestation.signingIdentity,
    executionPlanDigest: attestation.executionPlanDigest,
    profileSha256: attestation.profileSha256,
    profileSemanticsSha256: attestation.profileSemanticsSha256,
    attestationDigest: computeConfinementMeasurement(attestation),
    attestationMeasurement: attestation.measurement,
    commandReceiptDigests: commandReceipts.map((receipt) => receipt.receiptSha256),
    cleanupReceiptDigest: cleanupReceipt.receiptSha256,
  };
  return { ...bundle, receiptBundleSha256: computeConfinementMeasurement(bundle) };
}

export function unavailableConfinementLease(reason = 'No release-eligible confinement lease provider is configured.') {
  return {
    providerConfigured: false,
    status: 'unavailable',
    releaseEligible: false,
    attestationMeasurement: null,
    receiptBundleDigest: null,
    cleanupReceiptDigest: null,
    providerSha256: null,
    providerIdentityDigest: null,
    providerApprovalDigest: null,
    profileSha256: null,
    profileSemanticsSha256: null,
    executionPlanDigest: null,
    requiredRoles: [],
    observedRoles: [],
    commandReceiptCount: 0,
    attemptKey: null,
    configurationDigest: null,
    blockers: [reason],
  };
}

function withoutDigest(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validLeaseId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
