# Matched-evaluation release-gate evidence — 2026-08-01

## Result

The matched runner is reproducible and safe to exercise offline, but no live
stock-Codex-versus-Marshal release claim has been captured. No model turn or
billable token was used by this evidence.

The frozen `v1` corpus contains 18 cases across routing, memory, execution, UI,
and control. Three repetitions of two headline arms produce 108 required live
attempts. Its corpus digest is
`5755f63481d62c2e37b084be17f9eec40378ae4828ed9f5e2195d2bad544550a`.

## Proven offline

- Frozen corpus validation: 18 cases, 8 treatments, and 6 hash-pinned corpus
  files passed.
- Eval unit/protocol validation: 25/25 tests passed, including paired ordering,
  append-only evidence, resume, blind grading, plugin-arm isolation, network
  denial, default-off model invocation, explicit live authorization,
  descendant confinement, deterministic oracle binding, cost estimation, and
  rejection of wildcard trusted execution.
- The deterministic oracle exhaustively covers all 55 non-human assertions.
  Exact fixture facts, phase ordering, tool absence/use, receipts, and captured
  artifacts are graded without a model. UI/native host facts require typed
  references present in the captured-evidence inventory; missing evidence is a
  zero, never an inferred score.
- The confinement contract rejects cooperative, simulated, pass-through,
  test-only, non-inherited, and partial profiles. Preflight uses a fresh
  256-bit challenge and requires an exact-profile, exact-semantics,
  kernel-policy measurement before the same launcher wraps Codex and the
  objective oracle.
- A real local Codex full-corpus preflight materialized all 108/108 planned
  attempts across the 18 frozen cases and both headline arms. Every attempt was
  explicitly `unavailable`: 78 were blocked by the model-disabled safety latch
  and 30 required a desktop/UI host. Token totals were zero and no release
  claim was permitted.
- The preflight pinned model `gpt-5.6-sol`, reasoning `medium`, the exact Codex
  config without Marshal, the installed plugin tree, fixture trees, deny-all
  network policy, driver, and guard.
- The evidence format is now `1.2.0` and records four release attestations per
  attempt: operator authorization, network enforcement, descendant confinement
  profile, and deterministic objective oracle. A report is ineligible if any
  digest, pinned cost estimate, objective observation, or required UI capture
  is absent.

Latest machine-local full-corpus offline evidence:

- root:
  `%TEMP%\marshal-offline-full-q3`
- run configuration SHA-256:
  `402390d95f7ec25ebf4274ae2514b67b18bdf2cca8387315f51caf04a276f5c5`
- tool manifest SHA-256:
  `aeadddfbf1e62945240e0d41b441a2b263f0d5f641e226f66cd73d99f27b3aa5`
- attempt plan SHA-256:
  `c0d5f2778a71b5a14ae12a61c77b6262cd0a693a7c6c2d254aacc7f3160b5ab1`
- evidence JSONL SHA-256:
  `2b1e5c916b2bcf7f012ab0ad0858ed9dafeb33be3d9ce6ba45cbcf0cee1ca0b4`
- report JSON SHA-256:
  `b36cc15b14447ea01b986902b2a50ff941ddc9396dcafd4c2442b7cc025bb3ca`

For publication, `%TEMP%` denotes the historical machine-local temporary root;
the evidence digests remain those of the original captured files.

The report names the remaining prerequisites exactly:
`LIVE_MATCHED_EVIDENCE_REQUIRED`, `COMPLETE_ATTEMPT_SET_REQUIRED`,
`CLEAN_REPOSITORY_REQUIRED`, `RELEASE_ATTESTATIONS_REQUIRED`,
`PINNED_COST_REQUIRED`, `OBJECTIVE_EVIDENCE_REQUIRED`, and
`UI_EVIDENCE_REQUIRED`. Statistical gates remain `NOT EVALUATED` until those
prerequisites are satisfied.

## Live release run still required

The release gate remains blocked, accurately and intentionally, on:

1. a clean declared repository commit;
2. an installed brokered `bounded-agentic` Marshal plugin snapshot for the
   full corpus (`default` remains valid for non-subagent cases; the currently
   installed local plugin is `trusted-local` with wildcard package and builtin
   authority, which live preflight rejects);
3. an explicit, expiring, hash-pinned operator authorization for the exact
   108-attempt plan and its pinned USD pricing snapshot;
4. a real OS/process confinement launcher whose profile covers Codex,
   Marshal/plugin children, and workspace-command descendants;
5. real desktop-host evidence references for UI/native host facts (the
   deterministic oracle itself now covers all non-human assertions);
6. a desktop-host driver for MCP Apps interaction, restart, fullscreen/PiP,
   screenshots, and video; the CLI driver truthfully rejects UI cases;
7. blind human grades for every human-rubric assertion;
8. all 108 live attempts, published without exclusions or best-of-N selection,
   followed by the predeclared paired confidence and no-regression gates.

Until those items are supplied, the runner can prove reproducibility and
readiness but cannot prove product improvement.
