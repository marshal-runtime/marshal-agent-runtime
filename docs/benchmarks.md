# Direct runtime baseline

The checked-in baselines below are historical records for the direct provider
and frozen Codex compatibility paths. They are not Quillstone benchmark
results, Brain-extension validation, or proof that a packed consumer can
self-index.

`baseline.mjs` characterizes the current direct provider path without a harness,
MCP transport, hooks, or model calls. It measures:

- agent-scoped memory store and exact search latency/reliability;
- brokered TypeScript compilation and execution latency/reliability using an
  incident-feed parser and normalizer.

The benchmark uses only repository dependencies and built package output. All
SQLite and execution state is created under operating-system temporary
directories and removed before exit. Results are printed as JSON so later
changes can be compared with a checked-in or CI-captured baseline.

## Run

Build the packages, then execute the benchmark from the repository root:

```powershell
pnpm build
node scripts/benchmarks/baseline.mjs
```

For a quick smoke run or machine-readable-only output:

```powershell
node scripts/benchmarks/baseline.mjs --memory-samples 5 --typescript-samples 3 --json
```

The defaults are 30 memory samples and 20 TypeScript samples. The process exits
non-zero if an exact memory recall or TypeScript result validation fails. This
is intentionally a direct-runtime baseline: lifecycle-hook and end-to-end
harness latency belong in separate adapter benchmarks.

## Codex hook baseline

`codex-hook-baseline.mjs` measures that separate adapter path. It launches the
built `agent-runtime-codex` hook CLI as a new Node subprocess for representative
`SessionStart` and `UserPromptSubmit` events. Each scenario verifies an explicit
remember receipt, then opens a different task in a different temporary workspace
and verifies automatic agent-scoped recall. A second recall characterizes the
initialized-state path.

```powershell
pnpm build
node scripts/benchmarks/codex-hook-baseline.mjs
```

For a quick diagnostic run:

```powershell
node scripts/benchmarks/codex-hook-baseline.mjs --samples 1 --json
```

Unlike `baseline.mjs`, these timings include Node startup, Codex adapter
composition, lifecycle journaling, code-index status probing, SQLite startup, and
hook JSON serialization. “Warm-ish” does not mean a persistent runtime: every
hook remains a new process, while operating-system caches and persisted state
may be warm. The benchmark overrides the shared memory database path and uses
temporary workspaces, then recursively removes its temporary root. If the built
hook CLI is absent or its output is not valid hook JSON, the report contains an
explicit diagnostic rather than substituting a simulated lifecycle.

## Evidence and claims

Acceptance thresholds in benchmark output are targets, not release claims by
themselves. A publishable result retains the raw JSON, its SHA-256, environment,
configuration, sample counts, seed, warm/cold definition, failures, and the
exact source revision. Reports that lack explicit cache-hit receipts cannot
establish the cached-TypeScript target even when the observed wall time is
small.

The [evidence index](evidence/README.md) records all three checked-in final-source
100,000-memory passing reports (including the frozen post-hardening rerun), exact
metrics and hashes, the earlier local snapshot, and the preserved
ownership-fixture failure found during the final rerun. Future reports must be
added without replacing or relabeling earlier passing, failed, or blocked
snapshots.
