# Evaluation confinement launcher contract

The evaluation runner does not treat a JavaScript guard, a declared policy, or
a pass-through wrapper as a security boundary. A live release run must provide
a reviewed, hash-pinned launcher backed by an operating-system kernel boundary.
The repository defines and validates the contract; the OS-specific launcher is
an external release input.

## Profile

`driver.processConfinement.profileFile` is hash-pinned and must contain:

```json
{
  "schemaVersion": "1.0.0",
  "profileId": "windows-release-kernel-policy",
  "platforms": ["win32-x64"],
  "mechanism": "windows-appcontainer-job-firewall",
  "testOnly": false,
  "enforcementMode": "kernel",
  "denyByDefault": true,
  "descendantInheritance": "mandatory",
  "externalDataEgress": "deny-except-model-transport",
  "modelTransportIsolation": "parent-only",
  "filesystemOutsideAttempt": "read-only",
  "coverage": [
    "codex-process",
    "marshal-plugin-children",
    "workspace-command-children",
    "objective-oracle"
  ]
}
```

The validator rejects test, simulated, cooperative, or pass-through mechanisms;
best-effort descendant inheritance; shared child access to model transport;
write access outside the attempt; and incomplete coverage.

## Protocol

Before a live attempt, the runner invokes:

```text
<launcherCommand> <launcherArgs...> --attest <profileFile>
```

It sends a JSON request containing a fresh 256-bit challenge, the exact profile
SHA-256, the canonical profile-semantics SHA-256, and required coverage. The
launcher must return one JSON object containing the same challenge and digests,
the exact mechanism, `enforcementMode: "kernel"`,
`coversDescendants: true`, `testOnly: false`, complete coverage, and a
64-character measurement of the loaded kernel policy. Challenge mismatch
prevents replaying a previous attestation.

Every model phase and the deterministic objective oracle is then launched as:

```text
<launcherCommand> <launcherArgs...> --run <profileFile> <command> <args...>
```

The runner never invokes those live commands directly. Their environment is an
explicit allowlist; secret-bearing variable names are rejected.

## Platform implementation bar

An implementation must independently demonstrate that:

- policy applies before target code starts;
- child and grandchild processes cannot opt out;
- only the parent Codex model transport can reach its approved destination;
- Marshal MCP, hooks, authored TypeScript, packages, and workspace commands
  cannot reach external data sources;
- filesystem writes are confined to the attempt/state roots;
- termination kills the entire process tree;
- the emitted measurement changes when loaded kernel policy changes.

The checked-in protocol fixture exercises framing and validation only. It is
not an OS confinement implementation and cannot authorize a release run.

## Windows capability probe and partial Job Object launcher

`scripts/evals/security/windows-confinement-capability-probe.mjs` is a
hash-pinnable, probe-only executable for release preparation on Windows. It
checks the native Job Object and Process Sandbox API surfaces, current token,
and kernel network-filtering services, then evaluates those facts against every
invariant above. Run it with `--require-release` in automation; an ineligible
host exits `2`. The probe refuses `--attest` and `--run` with exit `64`, never
emits a successful confinement attestation, and must never be configured as
`driver.processConfinement`.

The current stock user-mode Windows composition is intentionally reported as
ineligible. Job Objects can provide inherited process-tree membership and
kill-on-close but do not impose filesystem or network policy. AppContainer and
ProcessContainer apply filesystem and network authority to the container token
and its process tree; granting model transport at that boundary does not prove
that only the parent Codex process can use it. A release therefore still needs
a separately reviewed, hash-pinned provider that can enforce and measure the
complete contract, such as a privileged service backed by an appropriate
signed kernel policy or a separately attested VM boundary.

The repository now implements that useful subset in
`scripts/evals/security/windows-job-object-launcher.mjs`. It starts a target
suspended, assigns it to a no-breakaway, kill-on-close Job Object before the
first target instruction, and monitors launcher-owner death. The corresponding
availability probe performs the same critical operation against a disposable
suspended target: it assigns the target, confirms membership with
`IsProcessInJob`, and terminates the Job before reporting the boundary
available. Exported API presence alone cannot enable the boundary. The
corresponding checked-in profile explicitly discloses unrestricted filesystem access,
unrestricted egress, shared descendant model-transport authority, and the
absence of a loaded network/filesystem policy measurement. It therefore cannot
pass `validateConfinementProfile`, and its challenge-bound `--attest` response
sets `ok: false` and `releaseEligible: false`. This is an enforced partial
boundary and a typed release blocker, not a successful confinement
attestation.

See [Windows confinement capability probe](windows-confinement-capability-probe.md)
for commands, interpretation, and the authoritative Windows API references.
