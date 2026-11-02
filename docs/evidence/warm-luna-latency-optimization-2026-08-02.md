# Warm Luna latency optimization — 2026-08-02

Evidence class: local-live bounded comparison. This evidence uses the production
Codex app-server Memory Brain adapter, the saved-in Codex account, exact model
`gpt-5.6-luna`, and app-server `modelProvider: openai`. It does not claim a
release-grade latency distribution.

## Changes under test

- supplied compact Brain-only `baseInstructions` instead of inheriting the
  general Codex base prompt;
- disabled unused reasoning-summary generation while preserving Luna `low`
  reasoning and strict structured tool intents;
- exposed the app-server service tier as an explicit adapter option without
  making the higher-cost `priority` tier the default;
- fixed the probe's required opaque `runId` isolation field.

The portable `RuntimeMemoryBrain` still owns hierarchy, search, dedupe,
placement, correction, authorization, provenance, tool execution, receipts,
and final injection. No deterministic marker path or model-free recall/store
path was introduced.

## Prompt audit

A captured production recall request contained 5,717 visible UTF-8 bytes:

| Component | Bytes |
| --- | ---: |
| Compact base instructions | 190 |
| Brain system prompt | 1,039 |
| Adapter developer wrapper | 626 |
| Developer instructions total | 1,665 |
| Brain transcript | 1,089 |
| Four portable tool declarations | 1,472 |
| Complete turn prompt | 2,878 |
| Strict response schema | 984 |
| Total visible request material | 5,717 |

The optimized canary reported roughly 6,689–6,706 input tokens per turn,
down from the historical 10,183–10,438. Marshal's visible request is only about
1.4k tokens at a coarse four-bytes-per-token estimate; the remaining input is
app-server/Codex-owned context. Removing the Brain hierarchy or portable tool
schemas would therefore trade semantic quality for a minority of the prompt.

## Named ten-pair comparisons

Every attempt returned the exact schema-valid `lookup_probe` then
`finish_probe` sequence. Nearest-rank p95 is calculated only over each named
ten-sample set.

| Configuration | Warm median | Warm p95 | First-turn median | First-turn p95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| low, default tier, compact base | 4,079.6 ms | 6,388.3 ms | 4,226.4 ms | 7,269.7 ms | miss |
| none, default tier, compact base | 3,053.3 ms | 5,135.1 ms | 3,066.8 ms | 5,881.1 ms | miss |
| low, priority tier, compact base | 3,208.1 ms | 6,101.4 ms | 3,296.6 ms | 4,935.2 ms | miss |
| none, priority tier, compact base | 3,346.3 ms | 6,013.6 ms | 3,996.2 ms | 7,084.1 ms | miss |
| low, default tier, no reasoning summary | 3,747.0 ms | 4,458.6 ms | 3,382.6 ms | 4,317.5 ms | cold target passes; warm target misses |

Final low/default warm durations, in sample order, were 3,747.0, 4,042.4,
3,986.8, 3,158.0, 3,569.9, 4,458.6, 3,609.3, 4,058.0, 2,815.1,
and 3,836.7 milliseconds. Corresponding first-turn durations were 3,828.4,
4,317.5, 3,054.0, 3,733.8, 3,284.2, 3,342.1, 3,815.1, 3,382.6,
2,922.5, and 3,717.3 milliseconds. Authenticated startup was 299.9 ms.

An additional experiment disabled other Brain-irrelevant Codex feature flags.
It did not reduce the 6.7k input-token floor or improve latency, so the
HIGH-blast-radius startup change was reverted.

## Frozen real-memory quality check

The low-effort/default-tier run passed 5/5 frozen `memory-brain-v2.1` cases
with weighted task success 1.0:

- ambient implicit capture;
- direct Brain remember;
- semantic weak-overlap recall;
- query refinement after a miss;
- irrelevant-memory abstention.

The five operations produced fourteen real Luna turns. Portable memory tool
work took 0–10 ms per call, while Luna turns took 2,615.3–5,956.4 ms. This
isolates the dominant remaining latency to the app-server/model request, not
SQLite, tool execution, process startup, JSONL transport, or hook blocking.
The raw report preserves prompt digests/sizes, model-turn durations and usage,
tool traces, selected/stored ids, receipts, assertions, and corpus digest:
[warm-luna-memory-quality-optimized-2026-08-02.json](warm-luna-memory-quality-optimized-2026-08-02.json).
Its SHA-256 is
`761636815FBF56B37718B845DED81E1FD0DE5C43CFEB720C37438A074D0D3576`.

## Honest result

The safe optimization reduces inherited context by roughly 35%, removes an
unused generated summary, keeps the complete Brain semantics, passes the frozen
quality sample, and meets the provisional cold-first-turn threshold in the
final named run. It does **not** meet the provisional warm p95 target of 2.5
seconds. Neither unsupported effort, the paid priority lane, nor disabling more
Codex surfaces produced a truthful pass. Meeting that target requires a
lower-latency host-native model callback/provider or a future faster app-server
path; caching or deterministic bypass would not prove the requested Luna Brain.
