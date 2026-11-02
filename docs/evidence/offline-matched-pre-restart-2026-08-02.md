# Offline matched evaluation before desktop restart — 2026-08-02

## Claim boundary

This is deterministic, model-disabled evidence. It validates the frozen corpus,
the matched baseline-versus-Marshal plan, plugin-arm isolation, configuration
pinning, append-only publication, and deterministic Memory Brain mechanics. It
does **not** claim that Marshal improves Codex, does not contain a live model
turn, and does not contain desktop MCP Apps evidence.

The authoritative machine-local artifacts are under:

```text
%TEMP%\marshal-offline-pre-restart-20260802-r2
```

For publication, `%TEMP%` denotes the historical machine-local temporary root;
the retained outputs and digests remain unchanged.

An earlier directory without the `-r2` suffix is deliberately excluded. Two
writers briefly targeted it concurrently; the runner detected duplicate attempt
keys and refused to publish a report. It is retained only as failure evidence,
not evaluation evidence.

## Frozen-corpus validation

Commands:

```powershell
node scripts/validate-evals.mjs
node --test scripts/evals/__tests__/*.test.mjs
```

Raw terminal result:

```text
Validated 18 cases, 55 objective assertions, 8 treatments, and 6 frozen files.
ℹ tests 31
ℹ suites 0
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11823.3479
```

The tests include paired deterministic ordering, append-only evidence and
resume behavior, baseline/Marshal plugin isolation, deny-all network preflight,
default-off model invocation, authorization/confinement failure closure,
objective-oracle coverage, frozen Memory Brain inputs, and desktop-UI evidence
rejection by the CLI driver.

## Full matched offline preflight

Commands:

```powershell
node scripts/evals/prepare-offline-smoke.mjs --output %TEMP%\marshal-offline-pre-restart-20260802-r2 --full-corpus
node scripts/evals/run.mjs --config %TEMP%\marshal-offline-pre-restart-20260802-r2\run-config.json --output %TEMP%\marshal-offline-pre-restart-20260802-r2\dry-run --dry-run
node scripts/evals/run.mjs --config %TEMP%\marshal-offline-pre-restart-20260802-r2\run-config.json --output %TEMP%\marshal-offline-pre-restart-20260802-r2\unavailable-run
```

Raw terminal results:

```text
Wrote dry-run plan for 108 attempts to %TEMP%\marshal-offline-pre-restart-20260802-r2\dry-run. No evaluation was executed.
Published 108/108 attempts to %TEMP%\marshal-offline-pre-restart-20260802-r2\unavailable-run. Release claim eligible: false.
```

Pinned environment:

```text
Corpus digest: 5755f63481d62c2e37b084be17f9eec40378ae4828ed9f5e2195d2bad544550a
Harness: codex 0.144.6
Model: gpt-5.6-sol
Reasoning: medium
Repository commit: 3fd4f43083c148cec06b0b285c13123ed2042b04
Repository dirty: true
Marshal plugin: marshal-runtime@personal 0.1.0+codex.20260802092659
Marshal tree digest: 94f819e0e68d1a8c1947e637e2b8af2589c66a64fcf2126de8e9e1926a81a32b
Marshal security profile: adaptive-agentic; no wildcard packages or builtins
Effective config without Marshal: babfc4ce48b4133ccac82327545368c2fcb3e23894cb87f1cb0189c35f93bc1d
Model invocation: false
Network fixture: deny-all
```

Observed result:

```text
Attempts: 108/108
Baseline attempts: 54
Marshal attempts: 54
Repetitions: 3
Missing attempts: 0
Unexpected attempts: 0
Unavailable evidence records: 108
Input tokens: 0
Output tokens: 0
Cached tokens: 0
Fixed matched configuration: PASS (a7c17317e1a3b5b04bab8f967768d3d6a7872bf6153a668c5a21a437d63b1bbf)
Publish all attempts: PASS
Minimum repetitions: PASS
Artifact publication safety: PASS
Release claim eligible: false
```

Both arms reported plugin isolation as available: only
`marshal-runtime@personal` changes between arms and the complete effective
enabled-plugin set is pinned. The dry-run plan and executed plan have the same
SHA-256 digest, proving the published attempts followed the inspected order.

Expected exclusions:

```text
78: Model invocation is disabled by driver.allowModelInvocation=false. This smoke configuration performs reproducibility preflight only.
30: This case requires interactive UI evidence, but codex exec has no MCP Apps render host or screenshot/video automation API. Use a separately validated desktop-host driver.
```

No paired score is meaningful: every record is explicitly unavailable and
excluded. The report correctly leaves statistical gates `NOT EVALUATED`.

Artifact SHA-256 values:

```text
0d9316d5cbe320530f8316a0d6c70eb7ac980c73facd355bbd6c0fa6b7619647  run-config.json
6d053a23c5b0b9201a919e8ac960d6de0d3bf6863ab609879b2cc7e549468903  tool-manifest.json
03660281c918fc70ebd3302425c42131013a6768cbb8f7e0111c9bc8225af11c  dry-run/plan.json
03660281c918fc70ebd3302425c42131013a6768cbb8f7e0111c9bc8225af11c  unavailable-run/plan.json
acead568b4ce6ce987c263a92922fb41f10e1b741fbde829874c0e375a293f06  unavailable-run/evidence.jsonl
1c9b05b0f45b9035481e0b51169a9f6da9ac5757e975c51e4475f2feaec6699a  unavailable-run/report.json
83a93ddaa72d5297449d6970e13c8e307f5daec37b79e7f137696e4ce6a8944d  unavailable-run/report.md
```

## Deterministic Memory Brain mechanics

Command:

```powershell
node scripts/evals/memory-brain-eval.mjs --output %TEMP%\marshal-offline-pre-restart-20260802-r2\memory-brain-mechanics.json
```

Raw result summary:

```json
{
  "schemaVersion": "1.0.0",
  "evidenceClass": "fixture",
  "evidenceLabel": "deterministic-mechanics-only",
  "qualityClaimAllowed": false,
  "corpusVersion": "memory-brain-v2.1",
  "corpusDigest": "79f674a8474ee2b4c3d74bbc4f847eb21bf3f4fbcdd9521cbd6417fda35736b8",
  "summary": {
    "total": 11,
    "passed": 11,
    "failed": 0,
    "releaseReady": true
  }
}
```

The 11 cases cover ambient capture, direct remember, semantic recall, query
refinement, correction/supersession, irrelevant-memory abstention, scope and
agent isolation, cross-process restart, stale/unavailable graph fallback,
tampered graph rejection, and the SQLite-versus-GitNexus discovery ablation.
This is mechanics evidence only; the scripted reasoner is not Luna quality
evidence.

```text
9034e50d525a33a4f4c676e00218fdd14521f84a304b9153f5af925455918127  memory-brain-mechanics.json
```

## What requires restart or live authorization

The next desktop restart can validate the installed Marshal snapshot in a
fresh Codex task and capture real MCP Apps rendering, interaction, persistence,
display modes, screenshots, and video. That is the remaining live Codex
desktop gate for the current UI release candidate.

A publishable 108-attempt improvement claim additionally requires a clean
declared commit, explicit expiring operator authorization and pricing,
hash-pinned descendant confinement, live model invocation for both arms, the
deterministic objective oracle, blind human grades, and complete desktop-host
UI evidence. None of those are fabricated by this pre-restart run.
