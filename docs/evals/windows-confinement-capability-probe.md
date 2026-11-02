# Windows confinement capability probe

Marshal includes both a production-readiness capability probe and a separate,
real Job Object descendant launcher. Neither is a complete production
confinement provider.

```powershell
node scripts/evals/security/windows-confinement-capability-probe.mjs --probe
node scripts/evals/security/windows-confinement-capability-probe.mjs --require-release
```

`--probe` always returns a bounded JSON report when the executable itself can
run. `--require-release` returns that same report and exits `2` unless the
report is release-eligible. This implementation is deliberately never
release-eligible because it observes stock host capabilities but neither loads
nor measures a Marshal kernel policy. `--attest` and `--run` are rejected with
exit `64`; the file cannot be substituted for the external launcher required by
the [confinement launcher contract](confinement-launcher-contract.md).

Hash-pin the probe when retaining readiness evidence:

```powershell
Get-FileHash -Algorithm SHA256 scripts/evals/security/windows-confinement-capability-probe.mjs
```

The report's `evidenceSha256` binds the canonical observed facts, primitive
assessment, blockers, and contract invariant list. It is a reproducibility
digest, not the `measurement` of loaded kernel policy required from a real
launcher.

## Real Job Object descendant boundary

The strongest boundary available under ordinary local Windows authority is
implemented by
`scripts/evals/security/windows-job-object-launcher.mjs`. Its reviewed profile
is
`scripts/evals/security/profiles/windows-job-object-descendants.json`.

```powershell
$launcher = (Resolve-Path scripts/evals/security/windows-job-object-launcher.mjs).Path
$profile = (Resolve-Path scripts/evals/security/profiles/windows-job-object-descendants.json).Path
node $launcher --probe $profile
node $launcher --run $profile (Get-Command node).Source -e "console.log('inside the Job Object')"
Get-FileHash -Algorithm SHA256 $launcher
Get-FileHash -Algorithm SHA256 scripts/evals/security/windows-job-object-host.ps1
Get-FileHash -Algorithm SHA256 $profile
```

The launcher creates the target suspended, configures
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns the target before its first
instruction, leaves breakaway disabled, resumes it, and monitors the launcher
owner. Normal children and grandchildren therefore remain in the Job Object;
closing the launcher or ending the target terminates remaining associated
descendants. The native helper is byte-pinned by the launcher, and `--probe`
does not infer availability from exported API presence: it creates a disposable
suspended target, assigns it, confirms membership with `IsProcessInJob`, and
terminates the Job before returning `boundaryAvailable: true`. The probe emits
exact launcher, helper, and profile hashes plus a deterministic measurement over
those bytes and the observed native policy.

This is real kernel-backed process-tree containment, not a cooperative wrapper.
It does not constrain filesystem access or network egress, cannot reserve model
transport for the parent process, and cannot measure a loaded filesystem or
network kernel policy. The profile states those four limitations and sets
`releaseEligible: false`. `--attest` challenge-binds and measures the partial
boundary but deliberately returns `ok: false`; the existing live runner rejects
it. `--run` accepts only the exact non-release Job Object profile. This prevents
the partial launcher from being substituted for the complete release contract.

The focused Windows tests verify the disposable availability assignment,
membership check and termination, child and grandchild Job membership,
suspended assignment, exit-code propagation, launcher-owner-death cleanup,
delayed escape prevention, exact-byte measurement changes, and fail-closed
release attestation. They do not establish filesystem or network isolation.

## Why stock non-admin Windows is insufficient

Windows exposes useful kernel-backed pieces, but no observed stock composition
satisfies the complete Marshal contract:

- [Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects)
  associate ordinary `CreateProcess` descendants with the job by default and
  can terminate the associated tree using `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
  Microsoft also documents that process security limits must be applied to
  individual processes on supported modern Windows. Job Objects do not define
  filesystem or network isolation.
- [AppContainer isolation](https://learn.microsoft.com/windows/win32/secauthz/appcontainer-isolation)
  is a kernel security boundary for process, filesystem, credential, and
  network access. Authority is capability/token based.
- The experimental
  [Create Process in Sandbox API](https://learn.microsoft.com/windows/win32/secauthz/createprocessinsandbox)
  can apply AppContainer-backed read-only/read-write path lists and a network
  policy. Its documented `internetClient` capability grants outbound network
  access to the sandboxed process boundary; the API does not document a
  parent-only grant that is revoked from arbitrary descendants.
- [Windows Filtering Platform](https://learn.microsoft.com/windows/win32/fwp/about-windows-filtering-platform)
  supports kernel enforcement and custom callouts, but the presence of the Base
  Filtering Engine or Windows Firewall service is not evidence that a reviewed
  Marshal-specific callout and policy are installed, active, descendant-aware,
  or measured.

Consequently, discovering Job Object and Process Sandbox APIs is useful but
cannot justify a successful attestation for `modelTransportIsolation:
"parent-only"`. A real Windows provider must independently prove the required
filesystem, network, descendant, startup-order, termination, and measurement
properties. Installing or configuring such a provider is privileged system
work and is outside a normal non-administrator evaluation process.

## Output fields

- `probeOnly: true` and `releaseEligible: false` prevent accidental promotion.
- `primitiveAssessment` separates what each native primitive can enforce from
  the missing cross-primitive guarantees.
- `hostFacts` contains bounded OS, token, service, and exported-API facts. It
  contains no environment variables or credentials.
- `blockers` lists independent fail-closed reasons rather than collapsing them
  into a generic unavailable result.
- `evidenceSha256` changes when any retained fact or conclusion changes.

The driver continues to accept only an absolute, hash-pinned
`driver.processConfinement` launcher/profile pair and its challenge-bound
successful full-contract attestation. Neither the probe nor the partial Job
Object launcher weakens or bypasses that path.
