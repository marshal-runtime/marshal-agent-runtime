import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIRED_CONFINEMENT_COVERAGE,
  validateConfinementAttestation,
  validateConfinementProfile,
} from '../security/confinement-contract.mjs';

test('release confinement requires kernel enforcement and complete inherited coverage', () => {
  const validated = validateConfinementProfile(validProfile(), 'win32-x64');
  assert.equal(validated.semanticsSha256.length, 64);
  assert.deepEqual(validated.semantics.coverage, [...REQUIRED_CONFINEMENT_COVERAGE].sort());
});

test('cooperative, pass-through, test-only, and partial profiles fail closed', () => {
  for (const mutation of [
    { mechanism: 'pass-through-wrapper' },
    { mechanism: 'cooperative-node-guard' },
    { testOnly: true },
    { enforcementMode: 'process' },
    { denyByDefault: false },
    { descendantInheritance: 'best-effort' },
    { modelTransportIsolation: 'shared-with-children' },
    { coverage: ['codex-process'] },
  ]) {
    assert.throws(() => validateConfinementProfile({ ...validProfile(), ...mutation }, 'win32-x64'));
  }
});

test('attestation is challenge-bound, measured, and exact-profile-bound', () => {
  const profile = validateConfinementProfile(validProfile(), 'win32-x64');
  const expected = {
    challenge: 'challenge-1',
    profileSha256: 'a'.repeat(64),
    profileSemanticsSha256: profile.semanticsSha256,
    mechanism: profile.profile.mechanism,
  };
  const attestation = {
    ok: true,
    ...expected,
    enforcementMode: 'kernel',
    coversDescendants: true,
    testOnly: false,
    coverage: REQUIRED_CONFINEMENT_COVERAGE,
    measurement: 'b'.repeat(64),
  };
  assert.equal(validateConfinementAttestation(attestation, expected), attestation);
  assert.throws(() => validateConfinementAttestation({ ...attestation, challenge: 'replayed' }, expected), /challenge/i);
  assert.throws(() => validateConfinementAttestation({ ...attestation, measurement: 'not-a-digest' }, expected), /measurement/i);
});

function validProfile() {
  return {
    schemaVersion: '1.0.0',
    profileId: 'windows-release-kernel-policy',
    platforms: ['win32-x64'],
    mechanism: 'windows-appcontainer-job-firewall',
    testOnly: false,
    enforcementMode: 'kernel',
    denyByDefault: true,
    descendantInheritance: 'mandatory',
    externalDataEgress: 'deny-except-model-transport',
    modelTransportIsolation: 'parent-only',
    filesystemOutsideAttempt: 'read-only',
    coverage: REQUIRED_CONFINEMENT_COVERAGE,
  };
}
