# Current-source 100,000-memory deterministic acceptance benchmark

Date: 2026-08-03

Evidence class: deterministic local benchmark

## Result

The current benchmarked package source passed all 10 predeclared deterministic
capacity gates with the unchanged full configuration: 100,000 memories, 20
quality queries with five relevant memories each, 20 cold memory samples, 20
warm memory samples, 20 uncached and 20 verified-cache-hit TypeScript
executions, and 100 UI actions.

This result covers the local providers exercised by the capacity runner. It is
not Luna or another live-model measurement, Codex-hook latency, autonomous
routing evidence, host UI pixels, or a matched stock-versus-Marshal evaluation.

## Candidate and environment

- Generated at: `2026-08-03T08:03:17.629Z`.
- Node: `v24.14.0`.
- Package manager: pnpm `10.32.1` through Corepack.
- Platform: Windows x64.
- Logical CPUs: 8.
- Corpus seed: `20260801`.
- Corpus digest:
  `sha256:7cc8e613fd84b298ddd5d3c6caf97d74a493ff5eea519929cf837619f7129c9b`.
- The benchmark packages were built while Git HEAD was
  `56ca446e9cfb74a697fd1cef4405373a9f400500`. HEAD advanced during the
  benchmark lane to `d9715085b4b1418fb7f671ab1987eda170dc0f97`; the only files
  changed between those commits were `scripts/acceptance-bindings.mjs` and
  `scripts/acceptance.mjs`, not a benchmark runner or benchmarked package.
- The worktree was not clean. At the benchmark lane's final status check,
  before this evidence page was authored, the pre-existing tracked
  modifications were limited to `AGENTS.md` and `CLAUDE.md`.

No raw JSON report was written for this run. The benchmark JSON was captured
and reduced in memory to avoid adding an unreviewed generated artifact. This
page therefore records a reproducible local observation, not an immutable raw
release-performance bundle.

## Exact commands

The four packages consumed by the benchmark were rebuilt from current source:

```powershell
corepack pnpm --filter @marshal/holographic-memory build
corepack pnpm --filter @marshal/agent-runtime-provider-memory build
corepack pnpm --filter @marshal/agent-runtime-typescript build
corepack pnpm --filter @marshal/agent-runtime-ui build
```

The benchmark acceptance library passed all seven self-tests:

```powershell
corepack pnpm exec node --test scripts/benchmarks/__tests__/capacity.test.mjs
```

The measured child process used the canonical unchanged defaults and enforced
every eligible gate:

```powershell
corepack pnpm exec node scripts/benchmarks/capacity.mjs --json --enforce
```

Its JSON stdout was captured by PowerShell and projected to the fields recorded
below; the process exited `0`.

## Configuration and sample counts

| Input | Count |
| --- | ---: |
| Seeded memories | 100,000 |
| Quality queries | 20 |
| Relevant memories per query | 5 |
| Cold memory samples | 20 |
| Warm memory samples | 20 |
| Uncached TypeScript executions | 20 |
| Same-source cached TypeScript executions | 20 |
| UI actions | 100 |

The SQLite fixture seed completed in `2,964.615 ms`. Retrieval went through
the public `memory.search` capability after deterministic batched SQLite seed
and an external-content FTS rebuild.

## Acceptance results

| Measure | Observed | Threshold | Result |
| --- | ---: | ---: | --- |
| Memory Recall@5 | 1.000 | at least 0.90 | pass |
| Memory nDCG@5 | 1.000 | at least 0.85 | pass |
| Irrelevant injection | 0% | at most 5% | pass |
| Warm memory store p95 | 5.322 ms | at most 250 ms | pass |
| Warm memory recall p95 | 0.831 ms | at most 250 ms | pass |
| Cold memory store p95 | 8.792 ms | at most 1,000 ms | pass |
| Cold memory recall p95 | 0.932 ms | at most 1,000 ms | pass |
| TypeScript uncached compile and execution p95 | 133.644 ms | at most 1,000 ms | pass |
| Verified cached TypeScript p95 | 66.171 ms | at most 250 ms | pass |
| UI action dispatch overhead p95 | 0.053 ms | at most 500 ms | pass |

The 20 retrieval queries returned 100/100 relevant results. TypeScript
reliability was 40/40 valid results. All 20 same-source executions carried a
digest-keyed cache-hit receipt and all 20 receipts recorded dependency-graph
validation.

Additional non-gating distributions from the same run were:

| Measure | p95 |
| --- | ---: |
| Quality-query wall latency | 1.394 ms |
| Uncached TypeScript compile component | 5.508 ms |
| Uncached TypeScript execution component | 81.930 ms |
| Cached dependency-graph validation | 2.844 ms |
| Cached execution component | 63.410 ms |

## Initial disk-full attempt and successful rerun

The first full invocation did not produce measurements. Drive `C:` had only
about `0.01 GB` free, and SQLite raised `database or disk is full` while the
fixture inserted records. The runner's unconditional cleanup then raised
`cannot rollback - no transaction is active`, masking the original SQLite
error in the normal stack. A read-only diagnostic exposed the underlying disk
error; no benchmark or product source was changed.

After unrelated disk pressure cleared and approximately `1,051 MiB` was free,
the exact full command above was rerun without changing its seed, counts, or
thresholds. That rerun exited `0` and produced the 10/10 result recorded here.
The failed first attempt is infrastructure evidence and also exposes a runner
diagnostic-quality issue; it is not counted as a product-performance sample.

## Limitations

- This is one local deterministic Windows run, not a repeated controlled or
  cross-platform latency distribution.
- Operating-system filesystem caches were not flushed. "Cold" means a fresh
  provider and SQLite connection, not a cold machine or filesystem cache.
- The seeded quality corpus uses exact deterministic cohort tokens. It tests
  capacity, ranking invariants, and irrelevant-result suppression, not natural
  semantic recall or Brain reasoning quality.
- The memory timings exclude Luna, model inference, durable job scheduling,
  hooks, and main-agent integration.
- The TypeScript timings exercise `DirectTypeScriptExecutor`; they do not
  measure a model deciding to author code or an end-to-end harness tool call.
- The UI timing is dispatcher overhead around a no-op target executor. It does
  not measure React compilation, host rendering, app-action network/tool work,
  desktop pixels, fullscreen, picture-in-picture, or user-perceived latency.
- There is no raw report hash, clean immutable candidate, independent review,
  or matched baseline attached to this run, so it must not support a release or
  comparative-improvement claim by itself.
