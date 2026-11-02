# Warm Luna Brain app-server probe — 2026-08-02

Evidence class: local-live-smoke. This probe tests whether the Codex adapter can
reuse authenticated local Codex infrastructure for a specialized Memory Brain
without starting `codex exec` for every memory operation. It is not a complete
Brain tool-loop, retrieval-quality, or release-performance result.

## Setup

- Windows x64, local Codex installation and existing signed-in Codex account.
- One persistent `codex app-server --stdio` child.
- One ephemeral `gpt-5.6-luna` thread reused for two turns.
- Read-only sandbox, `approvalPolicy: never`, no requested tool use.
- Compact memory-specialist developer instruction and strict JSON response.
- The second probe set reasoning effort to `low`.

The probe used the real `CodexAppServerBackend` from the current source tree.
The backend intentionally did not expose token accounting, so this evidence
must not be used for token or cost claims.

## Observations

| Probe | App-server/thread startup | First Luna turn | Second warm turn | Result |
| --- | ---: | ---: | ---: | --- |
| default effort | 2,565 ms | 5,838 ms | 2,175 ms | Stored “violet checklist”; later recalled “Violet” |
| low effort | 2,242 ms | 4,864 ms | 1,406 ms | Stored “canary check”; later recalled the requirement |

The earlier isolated `codex exec` experiment took approximately 18.9 seconds
for a trivial classification. This probe demonstrates that a persistent
app-server and warm Luna thread are a viable Codex-adapter direction and avoid
that per-call process/session cost.

## What remains unproven

- Dynamic Brain tools (`memory`, filesystem projection, and GitNexus) were not
  connected through app-server `dynamicTools` in this probe.
- The warm-thread isolation policy for different principals and scopes was not
  exercised.
- There are only two non-randomized samples; no p95 claim is valid.
- Cancellation, restart recovery, durable asynchronous jobs, and receipts were
  not exercised.
- Token usage and cost were not captured.

The production acceptance run must use the complete semantic Brain surface,
publish every sample, and preserve exact environment, trace, receipt, latency,
token, and cost evidence.
