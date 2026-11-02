# Memory Brain dynamic-tool transport evidence — 2026-08-03

## Claim boundary

The Codex app-server adapter can transport declared Brain calls back to the portable `RuntimeMemoryBrain` within one Luna turn. The portable Brain still owns tool validation, scope authorization, limits, memory and graph effects, candidate-reference resolution, traces, and receipts. The existing structured multi-round reasoner path remains available to adapters that do not support in-turn callbacks.

This evidence does **not** establish the desired 2.5-second warm latency. It also does not change the memory search algorithm or replace Luna.

## Deterministic verification

- Holographic-memory, provider-memory, and Codex typechecks passed.
- Provider-memory tests passed: 55/55, including a one-turn callback recall that searches and finishes through the portable Brain.
- Codex app-server tests passed: 15/15, including two sequential `item/tool/call` requests in one turn and exact response-schema handling.
- Two full Codex runs each passed 73/74; the sole unrelated delegation cleanup timing assertion failed only under full-suite concurrency and passed immediately on an isolated rerun together with all app-server tests (17/17).

## Live saved-auth result

Command configuration: `gpt-5.6-luna`, low effort, `query-refinement-after-miss`, three repetitions, one authenticated persistent app-server, maximum three Brain rounds and eight Brain calls.

- Quality: 3/3 passed; weighted task success 1.0.
- All attempts completed in one model turn and selected the exact authorized `candidate-1` reference.
- Brain calls per attempt: 2, 3, 3.
- Latency: 7.707s minimum, 9.104s median, 11.628s maximum.
- Earlier same-case structured fallback reference: 11.775s.
- Median improvement over that fallback reference: 2.671s, approximately 22.7%.
- SQLite/tool execution consumed only 8–39ms per attempt; model time was 7.548–11.503s.

Exact report: `C:\tmp\marshal-memory-dynamictools-live-20260803.json`

SHA-256: `2C28579D2069714FD8A3BE870FCEC39AE55C9FE2A2711252E3C29D48108AFD02`

## Remaining limitation

The production semantic loop is slower than the bounded toy transport probe because Luna performs two or three in-turn reasoning/tool phases with the complete Brain instructions and schemas (about 8.2k–8.8k input tokens). The current Codex app-server compatibility transport therefore does not meet the 2.5-second target. Further optimization should wait for a lower-latency host-native model callback rather than weakening semantic search, bypassing the Brain, caching answers, or changing the model.
