# Design-studio capstone attempt 5 — 2026-08-01

## Classification

`local-live-smoke`, interrupted and incomplete. This fresh installed-host attempt
establishes immediate implicit Marshal routing, editable TypeScript
orchestration, and a final set of four successful bounded native-agent
critiques. It is **not a capstone pass**: no frontend source was authored, no
React component was compiled or rendered, the state backend was not preserved
or executed, and the host/model stream ended before the task produced a final
answer.

## Frozen prompt

> Create a polished, persistent design workspace for a calm launch-planning
> product. Explore four meaningfully different visual and interaction
> directions, compare and critique them, synthesize the strongest approach,
> and let me refine the result directly here. Preserve editable source and
> state so I can reopen and continue later. Work autonomously and validate the
> result.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents. The fresh
Codex task alias was `design-studio-attempt-5-task`, using installed plugin
version `0.1.0+codex.20260801141748` and detached candidate
`%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801o`. The host declared the
workspace and `%TEMP%` writable, used workspace-write sandboxing, and disabled
interactive approval.

For publication, `%TEMP%` denotes the historical machine-local temporary root;
the retained hashes and timestamps below are unchanged.

## Timeline

All timestamps are UTC and come from the retained Codex session and Marshal
receipt journal.

| Event | Timestamp | Latency from prompt |
| --- | --- | ---: |
| Frozen prompt recorded | `2026-08-01T14:19:23.549Z` | 0 ms |
| Codex explicitly selected Marshal | `2026-08-01T14:19:29.845Z` | 6,296 ms |
| First Marshal capability receipt | `2026-08-01T14:21:01.399Z` | 97,850 ms |
| First artifact-store write after filesystem ACL mismatch | `2026-08-01T14:23:24.124Z` | 240,575 ms |
| Final four-agent orchestration completed | `2026-08-01T14:27:44.349Z` | 500,800 ms |
| Backend state-action source written to `%TEMP%` | `2026-08-01T14:29:34.015Z` | 610,466 ms |
| Session stream ended during model reasoning | `2026-08-01T14:30:13.466Z` | 649,917 ms |

The complete session record spans 653,858 ms from session metadata to the last
recorded event. There is no final assistant message or completed UI after that
event.

## What the attempt established

- Codex selected Marshal autonomously in 6.3 seconds and read the packaged
  React authoring contract. It did not route to generic visualization.
- Direct project-root file writes and patching were rejected despite the host
  describing the root as writable. Codex diagnosed this as an ACL mismatch and
  recovered to Marshal's scoped artifact store for the orchestration source.
- Codex authored a 5,477-byte editable TypeScript module with explicit depth,
  agent, concurrency, elapsed-time, token, retry, permission, effect, and
  idempotency bounds.
- The final execution launched four native design critics concurrently and
  collected four `succeeded` outcomes for Quiet Ledger, Horizon Map, Signal
  Garden, and Command Quiet. The module reported `status: success`, peak
  concurrency four, and 28,991.8 ms end-to-end duration.
- The model synthesized Quiet Ledger as the backbone and identified specific
  elements to borrow from the other three directions before beginning a
  backend state-action module.

## Defects and interruption exposed

The first multi-ID wait returned `limited` with
`invalid_request: wait requires existing, owned, unique delegation IDs.` A
second module revision still produced a limited aggregate. Codex then revised
the source to wait for each root delegation independently and in parallel.

That per-root version hit the advertised 30,000 ms module default:

- execution: `a76981c6-d3f2-4e9a-afe7-9bc6ad849f68`
- status: `timed_out`
- code: `TIMED_OUT`
- message: `Execution exceeded its 30000ms timeout.`
- observed duration: 30,116.6 ms

A retry of the same final source completed successfully in 28,991.8 ms. Across
the successive revisions and retries, the journal records 16 spawn operations,
not only the four useful final children. At inspection time the delegation
store contained seven `succeeded` records and nine older `running` records.
That retained work is evidence of retry overhead and incomplete cleanup, not a
claim that sixteen useful reviews completed.

After synthesis, Codex authored `%TEMP%\state-action.ts`. That source declares
project-scoped artifact save/load operations, but the turn ended before it was
copied into Marshal's artifact store, executed, or used for a save/reopen
round-trip. Therefore this attempt established **no durable application
state**.

The interruption occurred before UI authoring. The capstone workspace contains
no TSX or CSS frontend, the React UI store is empty, and the receipt journal
contains no `ui.compile`, `ui.render`, render-component, action, or
display-mode invocation. No inline UI, fullscreen/PiP negotiation, interaction,
fallback, restart recovery, visual QA, or media evidence exists for this
attempt.

## Receipt summary

The journal contains 79 top-level receipts: 78 `success` and one `cancelled`.
One top-level `success` receipt wraps the module whose result is explicitly
`timed_out`, so the status count must not be read as 78 successful user-level
outcomes.

| Target | Receipts |
| --- | ---: |
| `runtime.delegation.capabilities` | 1 |
| `runtime.delegation.spawn` | 16 |
| `runtime.delegation.wait` | 49 |
| `runtime.module.execute` | 4 |
| `artifacts.write` | 4 |
| `artifacts.read` | 5 |

## Retained file hashes

| File | Bytes | SHA-256 | Retention status |
| --- | ---: | --- | --- |
| Marshal artifact `source/design-review.ts` | 5,477 | `B6AFBF0A28E69893F7211D5ED3ABDCF8710A9B0CA4B028C9F733815DDF75652C` | Scoped workspace artifact |
| `%TEMP%\design-review.ts` | 5,477 | `B6AFBF0A28E69893F7211D5ED3ABDCF8710A9B0CA4B028C9F733815DDF75652C` | Temporary working copy |
| `%TEMP%\state-action.ts` | 1,559 | `D67AAC511570C644A6DFAB6A4DD48180EC2803B6D93FA626B7F8A26AF73887D7` | Temporary only; not stored or run |
| `receipts/executions.jsonl` | 184,518 | `491E079DAC870CD9E895C652389222A0D369FB68421A298AE1C8BF90D37C78C5` | Capstone workspace |
| Codex session JSONL | 1,345,405 | `4E53FCFC5EA896812F118B44B976C4DD5D1CDC40F63573AE410D0706CA958DB8` | Local Codex session store |

These retained files establish identity and runtime activity only. They are not
visual evidence and do not satisfy the capstone definition of done.

## Conditions for another capstone attempt

1. Prevent or clean up abandoned children when a brokered module times out or
   is retried, and make multi-root ownership semantics explicit in discovery.
2. Keep the orchestration within the module timeout or request an advertised,
   allowed timeout intentionally.
3. Verify the host's declared writable roots against actual sandbox ACLs before
   spending model time on failed direct writes.
4. Require the unchanged frozen prompt to complete frontend authoring,
   compilation, one direct in-chat render, live backend action, display-mode
   negotiation, durable save/reopen, host restart recovery, and retained
   receipts in one uninterrupted task.
