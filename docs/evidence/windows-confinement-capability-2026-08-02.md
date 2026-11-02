# Windows descendant-confinement capability evidence — 2026-08-02

This is readiness evidence, not live evaluation evidence and not a successful
kernel-policy attestation.

## Invocation

Repository commit before this scoped change: `6a77cc742ec3e758f00f46a2972b9fb7a2ae4434`.

```powershell
node scripts/evals/security/windows-confinement-capability-probe.mjs --require-release
```

Result: exit `2` (fail closed).

Probe file SHA-256 at execution:
`0c1d4a9e0db718d6d666735cbde8adf8cba242a1c3870bf0f36cce29289a3983`.

Canonical evidence SHA-256:
`8cc05e1de116edf30470bf1f45855a0ee5ee4ef36cc8d370fd2e95f2c289e68c`.

## Observed host facts

```json
{
  "platform": "win32-x64",
  "os": {
    "caption": "Microsoft Windows 11 Enterprise",
    "version": "10.0.26200",
    "buildNumber": "26200",
    "architecture": "64-bit"
  },
  "token": {
    "isAdministrator": false,
    "isAppContainer": false,
    "currentProcessIsInJob": true
  },
  "services": {
    "baseFilteringEngine": "Running",
    "windowsFirewall": "Running"
  },
  "jobObject": {
    "create": true,
    "assign": true,
    "configure": true,
    "query": true,
    "terminate": true
  },
  "processSandbox": {
    "dllPresent": true,
    "fileVersion": "10.0.26100.8737 (WinBuild.160101.0800)",
    "createProcess": true,
    "createProcessAsUser": true,
    "experimental": true
  }
}
```

## Contract conclusion

The Job Object API surface is present and can support non-breakaway tree
membership and whole-tree termination. The experimental Process Sandbox API is
also exported and can support AppContainer-backed uniform tree filesystem and
network policy. Neither observed stock primitive can prove parent-only model
transport while all arbitrary descendants remain denied, and neither emits the
required measurement of a loaded Marshal kernel policy.

The independent blockers were:

- current token cannot install or configure a privileged confinement provider;
- no reviewed external Marshal kernel-policy provider is configured;
- a stock tree-inherited AppContainer/ProcessContainer token cannot prove
  parent-only model transport;
- no loaded kernel-policy measurement is available.

Therefore this host cannot authorize release-eligible live Windows evaluation.
The existing evaluation driver remains fail-closed until a separate reviewed,
hash-pinned launcher and profile satisfy the complete contract.
