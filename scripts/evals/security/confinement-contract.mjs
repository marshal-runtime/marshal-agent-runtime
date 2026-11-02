import { createHash } from 'node:crypto';

export const REQUIRED_CONFINEMENT_COVERAGE = Object.freeze([
  'codex-process',
  'marshal-plugin-children',
  'workspace-command-children',
  'objective-oracle',
]);

export function validateConfinementProfile(profile, expectedOs) {
  assert(profile?.schemaVersion === '1.0.0', 'Confinement profile schemaVersion must be 1.0.0.');
  assert(typeof profile.profileId === 'string' && /^[a-z0-9][a-z0-9._-]+$/.test(profile.profileId), 'Confinement profileId is invalid.');
  assert(Array.isArray(profile.platforms) && profile.platforms.includes(expectedOs), `Confinement profile does not cover ${expectedOs}.`);
  assert(typeof profile.mechanism === 'string' && profile.mechanism.length > 0, 'Confinement mechanism is required.');
  assert(!/(?:fake|test|pass.?through|cooperative|simulat)/i.test(profile.mechanism), 'Test, pass-through, cooperative, or simulated confinement mechanisms are forbidden.');
  assert(profile.testOnly === false, 'Release confinement profile must set testOnly=false.');
  assert(profile.enforcementMode === 'kernel', 'Release confinement must be kernel-enforced.');
  assert(profile.denyByDefault === true, 'Release confinement must be deny-by-default.');
  assert(profile.descendantInheritance === 'mandatory', 'All descendant processes must inherit confinement.');
  assert(profile.externalDataEgress === 'deny-except-model-transport', 'External-data egress must be denied except for isolated model transport.');
  assert(profile.modelTransportIsolation === 'parent-only', 'Model transport must be available only to the parent Codex process.');
  assert(profile.filesystemOutsideAttempt === 'read-only', 'Filesystem access outside the attempt must be read-only.');
  assert(Array.isArray(profile.coverage), 'Confinement profile coverage is required.');
  const coverage = new Set(profile.coverage);
  assert(REQUIRED_CONFINEMENT_COVERAGE.every((value) => coverage.has(value)), 'Confinement profile coverage is incomplete.');
  const semantics = {
    coverage: [...coverage].sort(),
    denyByDefault: profile.denyByDefault,
    descendantInheritance: profile.descendantInheritance,
    enforcementMode: profile.enforcementMode,
    externalDataEgress: profile.externalDataEgress,
    filesystemOutsideAttempt: profile.filesystemOutsideAttempt,
    mechanism: profile.mechanism,
    modelTransportIsolation: profile.modelTransportIsolation,
    platforms: [...profile.platforms].sort(),
    profileId: profile.profileId,
    schemaVersion: profile.schemaVersion,
    testOnly: profile.testOnly,
  };
  return { profile, semantics, semanticsSha256: sha256(canonicalJson(semantics)) };
}

export function validateConfinementAttestation(attestation, expected) {
  assert(attestation?.ok === true, 'Confinement launcher did not attest success.');
  assert(attestation.challenge === expected.challenge, 'Confinement attestation challenge mismatch or replay.');
  assert(attestation.profileSha256 === expected.profileSha256, 'Confinement attestation profile digest mismatch.');
  assert(attestation.profileSemanticsSha256 === expected.profileSemanticsSha256, 'Confinement attestation semantics digest mismatch.');
  assert(attestation.mechanism === expected.mechanism, 'Confinement attestation mechanism mismatch.');
  assert(attestation.enforcementMode === 'kernel', 'Confinement attestation is not kernel-enforced.');
  assert(attestation.coversDescendants === true, 'Confinement attestation does not cover descendants.');
  assert(attestation.testOnly === false, 'Test-only confinement attestation is forbidden.');
  const coverage = new Set(attestation.coverage ?? []);
  assert(REQUIRED_CONFINEMENT_COVERAGE.every((value) => coverage.has(value)), 'Confinement attestation coverage is incomplete.');
  assert(typeof attestation.measurement === 'string' && /^[a-f0-9]{64}$/.test(attestation.measurement), 'Kernel-policy measurement is missing or invalid.');
  return attestation;
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
