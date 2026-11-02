# Warm Luna Memory Brain adapter probe — 2026-08-02

Evidence class: local-live-smoke. These are bounded Windows runs of the
production Codex Memory Brain app-server adapter. It is distinct from the
earlier backend-only experiment: the production adapter performed authenticated
startup, strict Responses-schema output, local portable-tool-schema validation,
usage capture, warm-thread reuse, and deterministic disposal.

## Command and contract

```powershell
corepack pnpm@10.32.1 --filter @marshal/agent-runtime-codex build
$env:MARSHAL_RUN_LIVE_LUNA_PROBE = '1'
node scripts/probes/warm-luna-appserver.mjs
```

The bounded comparison controls are
`MARSHAL_LUNA_PROBE_SAMPLES=1..10` and
`MARSHAL_LUNA_PROBE_EFFORT=none|low|medium`. A multi-sample run reports median
and nearest-rank p95, explicitly labeled as statistics for that named sample—not
a release p95.

- installed `@openai/codex` app-server over JSONL stdio;
- model `gpt-5.6-luna`, effort `low` unless the probe's explicit `none`
  comparison is selected;
- one lazy saved-auth app-server and one isolated ephemeral thread per sample;
- read-only sandbox with network disabled, approvals `never`, empty runtime
  workspace roots, ordinary tools/features disabled;
- no app-server `dynamicTools`, real memory operations, file writes, browsing,
  shell execution, delegation, or `codex exec`;
- round one requested the declared `lookup_probe` intent; a deterministic local
  fixture supplied `CANARY_OK`; round two requested `finish_probe` with that
  exact value;
- tool arguments crossed the Responses strict-schema envelope as bounded JSON
  strings, then were parsed and validated locally against each portable tool's
  full JSON schema before entering the portable Brain boundary.

The adapter follows the current official
[`account/read`, `thread/start`, and `turn/start` app-server protocol](https://developers.openai.com/codex/app-server/).

## Observed results

All eight sample pairs returned exactly `lookup_probe` then `finish_probe` with
schema-valid arguments.

Two single low-effort invocations were retained because they show the natural
variance that one attractive sample would hide:

| Run | Startup | First turn | Cold + first | Warm turn | Total | First usage (in/out) | Warm usage (in/out) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| low single A | 261.5 ms | 3,533.3 ms | 3,794.8 ms | 2,469.7 ms | 6,264.8 ms | 10,183 / 58 | 10,386 / 54 |
| low single B | 214.8 ms | 3,708.7 ms | 3,923.5 ms | 3,018.1 ms | 6,941.8 ms | 10,184 / 62 | 10,391 / 47 |

The bounded three-sample low-effort invocation took 25,796.2 ms after 296.9 ms
authenticated startup:

| Sample | First turn | Warm turn | First usage (in/out) | Warm usage (in/out) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 6,901.7 ms | 3,228.4 ms | 10,183 / 104 | 10,432 / 47 |
| 2 | 5,095.0 ms | 3,684.8 ms | 10,183 / 73 | 10,401 / 49 |
| 3 | 4,205.2 ms | 2,383.5 ms | 10,183 / 98 | 10,426 / 48 |

For those three low-effort samples, first-turn median / named-sample p95 were
5,095.0 / 6,901.7 ms; warm-turn median / named-sample p95 were 3,228.4 /
3,684.8 ms.

The bounded three-sample `none`-effort comparison took 23,033.9 ms after 390.9
ms authenticated startup:

| Sample | First turn | Warm turn | First usage (in/out) | Warm usage (in/out) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 5,268.0 ms | 4,555.0 ms | 10,242 / 33 | 10,420 / 34 |
| 2 | 4,457.0 ms | 1,917.6 ms | 10,258 / 33 | 10,436 / 34 |
| 3 | 4,522.5 ms | 1,922.4 ms | 10,260 / 33 | 10,438 / 34 |

For those three `none` samples, first-turn median / named-sample p95 were
4,522.5 / 5,268.0 ms; warm-turn median / named-sample p95 were 1,922.4 /
4,555.0 ms. The exact probe contract passed at both efforts, but that simple
canary does not establish equivalent real memory reasoning quality, so `low`
remains the default pending the frozen memory corpus.

## Honest boundary

This proves live saved-auth structured two-round protocol paths and warm-thread
reuse. Neither the two single runs nor either set of three samples proves a
release p95. In particular, the provisional warm p95 threshold of 2.5 seconds
was **not** met by either named three-sample set. These runs do **not** prove memory retrieval quality,
automatic routing, durable jobs, real SQLite/filesystem/GitNexus tool execution,
cross-profile isolation under a hostile client, cost, or cross-platform support.
The roughly 10k input tokens per turn include Codex/app-server context and are a
measured optimization target, not a cost or efficiency claim. Statistical
latency and quality claims still require the frozen repeated evaluation.
