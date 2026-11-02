# Final-source 100,000-memory capacity benchmark

Date: 2026-08-02

Evidence class: deterministic local benchmark

## Result

The final-source candidate passed all ten predeclared capacity gates with the
unchanged full configuration: 100,000 memories, 20 quality queries with five
relevant memories each, 20 cold memory samples, 20 warm memory samples, 20
uncached and 20 verified-cache-hit TypeScript executions, and 100 UI actions.

The raw passing report is
[`capacity-final-2026-08-02.json`](capacity-final-2026-08-02.json), SHA-256
`6DD95C746EBF40EFA15AA5FD3EF443EC1365AE79C772D68DDF8DFCAB9BF3EDCA`.
It contains the complete configuration, environment, methodology, individual
distribution summaries, cache receipts, thresholds, and gate results.

A second exact rerun after the complete release gate is preserved as
[`capacity-final-post-gate-2026-08-02.json`](capacity-final-post-gate-2026-08-02.json),
SHA-256
`D2FCB77AE3AFA12ADFB09F884741AE605BD56FEDA638EED297B44BEA4479D9F9`.
It used the same full configuration and passed 10/10 gates. It does not replace
the earlier passing run or the preserved failed ownership-fixture attempt.

## Exact invocation and candidate

```powershell
corepack pnpm@10.32.1 --filter @marshal/holographic-memory build
corepack pnpm@10.32.1 --filter @marshal/agent-runtime-provider-memory build
corepack pnpm@10.32.1 --filter @marshal/agent-runtime-typescript build
corepack pnpm@10.32.1 --filter @marshal/agent-runtime-ui build
node --test scripts/benchmarks/__tests__/capacity.test.mjs
node scripts/benchmarks/capacity.mjs --output docs/evidence/capacity-final-2026-08-02.json --json --enforce
```

- Git HEAD: `3fd4f43083c148cec06b0b285c13123ed2042b04`.
- Worktree state: dirty final integration candidate; no commit was created.
- Code-tree SHA-256: `441915190D9B1F95BA20BFC0C55DE79931EE973DB03D6FFB53C07CA83934F1AC`.
  This hashes the sorted path plus SHA-256 of every one of the 600 Git-visible
  non-documentation files, so untracked candidate source is included.
- Runner SHA-256: `795E26752C83E01C2B3CFFE3D5DA294129D2D07FF63EF4A2BB47BB1FFD19A067`.
- Corpus/acceptance library SHA-256:
  `1E358557B0341F63CD59CC213DE5B02283E96036E761CF55B61AB0851CD11957`.
- Lockfile SHA-256:
  `6CA46885B2D8E13C00D57D3854A1D397D1BCB106374FB020193CF6CA0CC4A26A`.
- Environment: Node `v24.14.0`, Windows x64, eight logical CPUs.
- Deterministic corpus digest:
  `sha256:7cc8e613fd84b298ddd5d3c6caf97d74a493ff5eea519929cf837619f7129c9b`.
- Benchmark self-tests: 7/7 passed immediately before the measured run.

## Observed gates

| Measure | Final observed | Threshold | Result |
| --- | ---: | ---: | --- |
| Memory Recall@5 | 1.000 | at least 0.90 | pass |
| Memory nDCG@5 | 1.000 | at least 0.85 | pass |
| Irrelevant injection | 0% | at most 5% | pass |
| Warm memory store p95 | 6.592 ms | at most 250 ms | pass |
| Warm memory recall p95 | 2.812 ms | at most 250 ms | pass |
| Cold memory store p95 | 12.951 ms | at most 1,000 ms | pass |
| Cold memory recall p95 | 1.947 ms | at most 1,000 ms | pass |
| TypeScript uncached p95 | 523.672 ms | at most 1,000 ms | pass |
| Verified cached TypeScript p95 | 224.703 ms | at most 250 ms | pass |
| UI action dispatch overhead p95 | 0.074 ms | at most 500 ms | pass |

TypeScript reliability was 40/40. All 20 same-source executions carried a
digest-keyed cache-hit receipt and dependency-graph validation.

## Post-gate exact rerun

The post-gate rerun again produced Recall@5 and nDCG@5 of 1.000, zero
irrelevant results, and 40/40 valid TypeScript executions. Its p95s were:

| Measure | Post-gate observed | Threshold | Result |
| --- | ---: | ---: | --- |
| Warm memory store | 5.823 ms | at most 250 ms | pass |
| Warm memory recall | 1.107 ms | at most 250 ms | pass |
| Cold memory store | 28.791 ms | at most 1,000 ms | pass |
| Cold memory recall | 1.203 ms | at most 1,000 ms | pass |
| TypeScript uncached | 174.982 ms | at most 1,000 ms | pass |
| Verified cached TypeScript | 112.728 ms | at most 250 ms | pass |
| UI action dispatch overhead | 0.046 ms | at most 500 ms | pass |

These materially different wall times reinforce the stated limitation: the
reports are deterministic correctness/capacity evidence, while publication
latency claims still require repeated controlled and cross-platform runs.

## Frozen post-hardening rerun

After the shared stable-file identity/snapshot remediation, the complete
workspace verification, and the detached offline-publication gate passed, the
full capacity command was run once more without reducing any sample count:

```powershell
node scripts/benchmarks/capacity.mjs --output docs/evidence/capacity-final-frozen-2026-08-02.json --enforce --json
```

The raw report is
[`capacity-final-frozen-2026-08-02.json`](capacity-final-frozen-2026-08-02.json),
SHA-256
`20360FCF60BFC4D880C277FF3E53781A0C50C060EC985CB77D6D44125D6D3518`.
It was generated at `2026-08-02T10:50:18.128Z` with Node `v24.14.0` on
Windows x64 using the unchanged 100,000-entry configuration and corpus digest
`sha256:7cc8e613fd84b298ddd5d3c6caf97d74a493ff5eea519929cf837619f7129c9b`.

| Measure | Frozen observed | Threshold | Result |
| --- | ---: | ---: | --- |
| Memory Recall@5 | 1.000 | at least 0.90 | pass |
| Memory nDCG@5 | 1.000 | at least 0.85 | pass |
| Irrelevant injection | 0% | at most 5% | pass |
| Warm memory store p95 | 4.745 ms | at most 250 ms | pass |
| Warm memory recall p95 | 0.901 ms | at most 250 ms | pass |
| Cold memory store p95 | 9.893 ms | at most 1,000 ms | pass |
| Cold memory recall p95 | 0.981 ms | at most 1,000 ms | pass |
| TypeScript uncached p95 | 86.395 ms | at most 1,000 ms | pass |
| Verified cached TypeScript p95 | 101.295 ms | at most 250 ms | pass |
| UI action dispatch overhead p95 | 0.058 ms | at most 500 ms | pass |

TypeScript reliability was again 40/40, with 20/20 same-source executions
carrying verified digest-keyed cache-hit and dependency-graph-validation
receipts. This is the authoritative capacity report for the final pre-commit
runtime bytes; immutable commit identifiers are recorded separately after the
three repository commits exist.

## Comparison with the 2026-08-01 snapshot

Both runs used the same machine class, Node version, seed, sample counts, and
thresholds. Negative percentages are faster. These are single-run local wall
times, so changes must not be attributed to one code change without a repeated,
controlled benchmark.

| p95 measure | 2026-08-01 | Final source | Change |
| --- | ---: | ---: | ---: |
| Warm memory store | 8.757 ms | 6.592 ms | -24.7% |
| Warm memory recall | 1.208 ms | 2.812 ms | +132.8% |
| Cold memory store | 33.665 ms | 12.951 ms | -61.5% |
| Cold memory recall | 2.003 ms | 1.947 ms | -2.8% |
| TypeScript uncached | 257.770 ms | 523.672 ms | +103.2% |
| Verified cached TypeScript | 110.324 ms | 224.703 ms | +103.7% |
| UI dispatch overhead | 0.079 ms | 0.074 ms | -6.3% |

Memory quality remained perfect. Memory stores improved, warm recall remained
far inside its target despite increasing, and TypeScript wall time roughly
doubled. The cached TypeScript p95 has only 25.297 ms of headroom, so repeated
cross-platform measurements remain necessary before treating that latency as
stable.

## Preserved invalid first attempt

The first final-source execution is preserved as
[`capacity-final-ownership-mismatch-failed-2026-08-02.json`](capacity-final-ownership-mismatch-failed-2026-08-02.json),
SHA-256
`317A1CBEA45C6499E9CD33EBA1D0EA5A6B69EEF15186043C7CC501BF94FB0A5D`.
It reported zero returned memories because the old benchmark fixture seeded the
literal owner `capacity-agent`, while final Marshal authorizes agent memory with
an opaque owner derived from principal and agent identity. Latency, TypeScript,
and UI paths still ran, but its memory-quality result is invalid as a product
measurement.

The runner was corrected to derive its seed owner through the exported
`resolveMemoryOwnership('agent', context)` contract used by the public memory
capability. GitNexus impact analysis rated the three touched benchmark symbols
LOW and confined them to the Benchmarks module. The failed report was not
deleted or relabeled.

## Limitations

- This is deterministic local provider evidence, not live-model or Codex-hook
  latency and not a matched baseline comparison.
- Operating-system caches were not flushed; “cold” means a fresh provider and
  SQLite connection, as stated in the raw methodology.
- The result is one run on a dirty integration candidate. The code-tree digest
  makes it reproducible, but a clean release commit and repeated Windows/Linux
  runs are still required for a publication-grade performance claim.
- The corpus uses exact deterministic cohort tokens. It validates capacity,
  ranking invariants, and irrelevant-result suppression; semantic Brain/Luna
  quality is covered by separate evaluations.
