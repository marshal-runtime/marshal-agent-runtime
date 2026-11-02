# Candidate M current-source release-gate audit

Date: 2026-08-03

Class: deterministic and unavailable-evidence preflight

Source commit observed: `463127e7ed51bf0f08736071df1aa8e85c38a5b2`
Repository state: dirty; the active adapter/session-identity work and this audit
were not an immutable release candidate.

This audit checks the non-model, non-desktop release machinery against the
current source. It does not claim that the Candidate M live acceptance, matched
stock-Codex comparison, registry publication, or independent review has passed.

## Installed treatment pin

The generated tool manifest identified the installed personal plugin as:

- plugin: `marshal-runtime@personal`
- version: `0.1.0+codex.20260803121042`
- canonical plugin tree SHA-256:
  `c1876d732e2653dc88169a8f69a859ae20c3dbcd74c41ce67281430c60020b61`
- permission profile: `adaptive-agentic`
- wildcard package/builtin grants: none
- effective stock configuration SHA-256:
  `8006acfe1781422c0dda55c53368d0f96f698b89c4b831134c3491e9171a38bd`

## Passing deterministic gates

All commands used the repository-pinned `pnpm@10.32.1` through Corepack.

| Gate | Result |
| --- | --- |
| Frozen evaluation corpus | 18 cases, 55 objective assertions, 8 treatments, and 6 frozen files validated |
| Evaluation tests after writer-lock hardening | 65/65 passed |
| Portable conformance | 6/6 passed, including the official ext-apps bridge and standards-only adaptive host |
| Publication UI/capture/standards tests | 13/13 passed |
| Release engineering | 11/11 passed, including real `npm publish --dry-run` over packed tarballs in dependency order |
| Release policy/inventory/plan | 20 package authority-template, SPDX/license inventory, and dependency-order checks passed |
| Documentation and repository boundaries | docs, package manifests, portable dependency direction, and runtime-only repository checks passed |
| Offline publication rehearsal | 20 packages built; detached generic MCP execution, lifecycle replay, memory/restart, receipt journal, standards-only UI, workspace isolation, and 40/40 publication tests passed |

The first publication attempt resolved global `pnpm@8.14.3` and failed the
intentional package-manager pin. Rerunning through Corepack resolved
`pnpm@10.32.1`; the product and publication gates then passed.

## Full matched-evaluation preflight

The full frozen matched plan was generated at:

`C:\tmp\marshal-candidate-m-full-preflight-release-agent-locked`

The run published all 108 expected records in randomized matched order:

- 18 cases;
- two headline arms;
- three repetitions;
- 108 unique attempt keys;
- zero model calls and zero tokens;
- 78 attempts excluded by the deliberate model-invocation latch;
- 30 UI attempts excluded because the CLI driver cannot provide desktop-host
  pixels or interaction evidence.

The run is intentionally classified `unavailable`, and
`releaseClaim.eligible` is `false`. It proves complete planning, treatment
pinning, preflight behavior, and fail-closed evidence handling—not comparative
quality.

| File | SHA-256 |
| --- | --- |
| `unavailable-run/plan.json` | `B0DDA835BE1426FAA867CF8C6DDD267352B93168961D4CD66F477273A60B1CE5` |
| `unavailable-run/evidence.jsonl` | `620665F96CADF51887779783C299607D13E8C20D60B7C68A14FEF30627276FF6` |
| `unavailable-run/report.json` | `59BCFF1C055F4C537989136BE40F7AED0B8FBA286C02CFDEB5B438EFD23A6C7A` |
| `unavailable-run/report.md` | `35D2927F0BDA25ECBDC3CD2C27783E50C2C72691BD5CD536AD249BC4882E2DB8` |

## Runner integrity finding and correction

During the audit, an original preflight writer was mistakenly resumed before
the original process had exited. Both processes appended to the same JSONL
file, creating duplicate attempt keys. The runner rejected that evidence at
report generation, but it had not prevented the competing writer.

The current source now acquires one exclusive `.writer.lock` per run directory
before reading or appending evidence. A live or unreadable owner fails closed.
When the recorded PID is valid and the operating system definitively reports
that it no longer exists, resume reclaims the lock while holding a separate
exclusive recovery guard. A regression test proves live-owner rejection,
Windows stale-PID recovery, and duplicate-free resume. The clean replacement
preflight above contains 108 rows and 108 unique keys.

## Release gates still open

1. **Candidate M live acceptance:** assemble passing attributable evidence for
   memory isolation, stable workflow replay/no-orphans, and real Codex outer
   renderer controls plus restart restoration.
2. **Matched live comparison:** run all 108 stock-versus-Marshal attempts from
   a clean immutable candidate with operator authorization, pinned pricing,
   objective evidence, and a reviewed release-eligible process-confinement
   provider. The current Windows Job Object probe is deliberately insufficient
   for descendant network/filesystem confinement.
3. **Desktop evidence:** supply a validated desktop-host driver for the UI
   family, complete blind human grades, and publish failures as well as passes.
4. **Published-artifact matrix:** publish under owner authority, then verify
   registry tarballs outside the source repository across the declared OS/Node
   matrix.
5. **Human release review and media:** complete independent security, privacy,
   accessibility, and reproducibility review; capture uncut runs; derive
   provenance-linked GIF/MP4/WebM demonstrations.

No deterministic test, generated fixture, automated CDP screenshot, or
model-disabled preflight is promoted to evidence for those five gates.
